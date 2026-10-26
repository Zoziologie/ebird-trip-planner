// End-to-end performance check against a realistically sized EBD.
//
// standard-flow.mjs guards correctness and fixed overhead on a tiny dataset.
// This one guards the thing that actually breaks on real trips: memory and
// interaction cost once a large export has been processed.
//
//   node tests/perf/make-ebd-fixture.mjs --scale 2 --out /tmp/ebd-2x.txt
//   zip -j -q /tmp/ebd-2x.zip /tmp/ebd-2x.txt
//   npm run perf:large-flow -- /tmp/ebd-2x.zip
//
// See tests/perf/README.md for what "realistically sized" means and why the
// post-import numbers matter more than the import itself.

import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { mkdtemp } from "node:fs/promises";
import { chromium } from "playwright";

const ROOT = process.cwd();
const BASE_PATH = "/ebird-trip-planner/";

const fixture = process.argv[2];
if (!fixture) {
  console.error("Usage: npm run perf:large-flow -- /path/to/ebd-fixture.zip");
  process.exit(1);
}

// Budgets sit just above what a scale-2 fixture measures today, so this catches
// regressions rather than restating a known gap. Heap is the assertion that
// matters: importing happens on a desktop, but opening a trip has to work on a
// phone. Override any of them with PERF_<key> env vars.
const DEFAULT_THRESHOLDS = {
  importMs: 120000,
  createTripMs: 30000,
  speciesListMs: 8000,
  sortMs: 2000,
  speciesMapMs: 20000,
  buildTripMs: 30000,
  dragFramesMs: 2000,
  speciesListHeapMb: 400,
  speciesMapHeapMb: 450,
  buildTripHeapMb: 650,
};
const thresholds = Object.fromEntries(
  Object.entries(DEFAULT_THRESHOLDS).map(([key, fallback]) => [
    key,
    Number(process.env[`PERF_${key}`]) || fallback,
  ]),
);

const findFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const waitForServer = async (url, timeoutMs = 30000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
  });

const timed = async (fn) => {
  const startedAt = performance.now();
  await fn();
  return Math.round(performance.now() - startedAt);
};

let preview;
let browser;
const results = [];
const failures = [];
const record = (key, actual) => {
  const limit = thresholds[key];
  const ok = limit === undefined || actual <= limit;
  results.push({ key, actual, limit: limit ?? "-", ok });
  if (!ok) failures.push(`${key}: ${actual} > ${limit}`);
};

try {
  await run("npm", ["run", "build"]);

  const port = await findFreePort();
  const origin = `http://127.0.0.1:${port}`;
  preview = spawn(
    path.join(ROOT, "node_modules", ".bin", "vite"),
    ["preview", "--host", "127.0.0.1", "--port", String(port)],
    { cwd: ROOT, stdio: "ignore" },
  );
  await waitForServer(`${origin}${BASE_PATH}`);

  // A persistent profile is required, not a preference: an ephemeral Playwright
  // context caps a single IndexedDB value at ~127 MiB and rejects a large trip
  // that a real browser stores without complaint. See tests/perf/README.md.
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "ebtp-perf-"));
  const launchOptions = {
    headless: process.env.PERF_HEADFUL !== "1",
    viewport: { width: 1400, height: 900 },
    args: ["--js-flags=--expose-gc --max-old-space-size=8192"],
  };
  try {
    browser = await chromium.launchPersistentContext(profileDir, launchOptions);
  } catch {
    browser = await chromium.launchPersistentContext(profileDir, { ...launchOptions, channel: "chrome" });
  }
  const context = browser;
  const page = context.pages()[0] || (await context.newPage());
  const cdpSession = await context.newCDPSession(page);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(`console: ${message.text()}`);
  });
  const heapMb = async () => {
    await cdpSession.send("HeapProfiler.collectGarbage");
    const heap = await cdpSession.send("Runtime.getHeapUsage").catch(() => null);
    return Math.round((heap?.usedSize || 0) / 1024 / 1024);
  };

  await page.goto(`${origin}${BASE_PATH}create`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Create from eBird data", exact: true }).waitFor();

  record(
    "importMs",
    await timed(async () => {
      await page.getByRole("button", { name: "Create from eBird data", exact: true }).click();
      await page.setInputFiles("#fileInput", [fixture]);
      await page
        .getByText(/Loaded [\d,]+ records into [\d,]+ checklists\./)
        .waitFor({ timeout: thresholds.importMs + 60000 });
    }),
  );
  const loaded = await page.getByText(/Loaded [\d,]+ records into [\d,]+ checklists\./).innerText();

  record(
    "createTripMs",
    await timed(async () => {
      await page.getByLabel("Trip name", { exact: true }).fill("Performance test trip");
      await page.getByRole("button", { name: /^Create Trip$/ }).click();
      await page.getByText("Total Species (EBD):").waitFor({ timeout: thresholds.createTripMs + 30000 });
    }),
  );

  record(
    "speciesListMs",
    await timed(async () => {
      await page.getByRole("link", { name: "Species List" }).click();
      await page
        .locator('input[aria-label="Average trip (min)"]')
        .first()
        .evaluate((input) => {
          input.value = "0";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        });
      await page.locator("tbody tr.species-row").first().waitFor({ timeout: thresholds.speciesListMs + 30000 });
    }),
  );
  record("speciesListHeapMb", await heapMb());

  record(
    "sortMs",
    await timed(async () => {
      await page.getByRole("button", { name: /^Species/ }).first().click();
      await page.locator("tbody tr.species-row").first().waitFor();
    }),
  );

  record(
    "speciesMapMs",
    await timed(async () => {
      await page.getByRole("link", { name: "Species Map" }).click();
      await page.getByText(/clusters across \d+ locations/).waitFor({ timeout: thresholds.speciesMapMs + 60000 });
    }),
  );
  const clusters = (await page.getByText(/clusters across \d+ locations/).innerText()).trim();
  record("speciesMapHeapMb", await heapMb());

  record(
    "buildTripMs",
    await timed(async () => {
      await page.getByRole("link", { name: "Build Trip" }).click();
      await page.locator(".mapboxgl-canvas").waitFor({ timeout: thresholds.buildTripMs + 30000 });
      await page.waitForTimeout(3000);
    }),
  );
  record("buildTripHeapMb", await heapMb());

  // Dragging a visit re-renders the visit layers on every pointer move; this is
  // where a large location set used to stall the map.
  await page.locator("button:has(i.bi-plus-lg)").first().click();
  const canvas = await page.locator(".mapboxgl-canvas").boundingBox();
  await page.mouse.click(canvas.x + canvas.width * 0.5, canvas.y + canvas.height * 0.5);
  await page.waitForTimeout(2500);
  const handle = page.locator(".visit-center-handle").first();
  await handle.waitFor({ timeout: 60000 });
  const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  record(
    "dragFramesMs",
    await timed(async () => {
      for (let i = 1; i <= 30; i += 1) {
        await page.mouse.move(
          handleBox.x + handleBox.width / 2 + i * 3,
          handleBox.y + handleBox.height / 2 + i * 2,
        );
      }
    }),
  );
  await page.mouse.up();
  await page.waitForTimeout(1500);

  console.log(`\nfixture: ${path.basename(fixture)}`);
  console.log(`${loaded.trim()} | ${clusters}`);
  console.table(
    results.map((row) => ({
      metric: row.key,
      actual: row.key.endsWith("HeapMb") ? `${row.actual} MB` : `${row.actual} ms`,
      limit: row.key.endsWith("HeapMb") ? `${row.limit} MB` : `${row.limit} ms`,
      ok: row.ok,
    })),
  );
  if (pageErrors.length) {
    failures.push(`${pageErrors.length} page error(s)`);
    console.error(pageErrors.slice(0, 5).join("\n"));
  }
  if (failures.length) throw new Error(`Performance thresholds exceeded:\n${failures.join("\n")}`);
} finally {
  if (browser) await browser.close();
  if (preview) preview.kill("SIGTERM");
}
