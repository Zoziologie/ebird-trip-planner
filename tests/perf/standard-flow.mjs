import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import process from "node:process";
import { chromium } from "playwright";

const ROOT = process.cwd();
const BASE_PATH = "/ebird-trip-planner/";
const DEFAULT_THRESHOLDS = {
  firstLoadMs: 3500,
  ebdReadMs: 8000,
  createTripMs: 12000,
  speciesListLoadMs: 2500,
  sortClickMs: 1000,
  repeatedNavigationMs: 12000,
  heapGrowthMb: 20,
};

const thresholds = Object.fromEntries(
  Object.entries(DEFAULT_THRESHOLDS).map(([key, fallback]) => [
    key,
    Number(process.env[`PERF_${key}`]) || fallback,
  ]),
);

const timed = async (name, fn) => {
  const start = performance.now();
  await fn();
  return { name, ms: Math.round(performance.now() - start) };
};

const findFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: options.stdio || "inherit",
      shell: false,
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });

const waitForServer = async (url, timeoutMs = 15000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const createSyntheticEbd = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ebird-perf-"));
  const filePaths = [
    path.join(dir, "synthetic-ebd-1.txt"),
    path.join(dir, "synthetic-ebd-2.txt"),
  ];
  const species = [
    ["Common Ostrich", "Struthio camelus"],
    ["Somali Ostrich", "Struthio molybdophanes"],
    ["Southern Cassowary", "Casuarius casuarius"],
    ["Dwarf Cassowary", "Casuarius bennetti"],
    ["Northern Cassowary", "Casuarius unappendiculatus"],
    ["Emu", "Dromaius novaehollandiae"],
    ["Southern Brown Kiwi", "Apteryx australis"],
    ["Great Spotted Kiwi", "Apteryx haastii"],
  ];
  const headers = [
    "GLOBAL UNIQUE IDENTIFIER",
    "LAST EDITED DATE",
    "TAXONOMIC ORDER",
    "CATEGORY",
    "COMMON NAME",
    "SCIENTIFIC NAME",
    "OBSERVATION COUNT",
    "BREEDING CODE",
    "BREEDING CATEGORY",
    "BEHAVIOR CODE",
    "AGE/SEX",
    "COUNTRY",
    "COUNTRY CODE",
    "STATE",
    "STATE CODE",
    "COUNTY",
    "COUNTY CODE",
    "LOCALITY",
    "LOCALITY ID",
    "LOCALITY TYPE",
    "LATITUDE",
    "LONGITUDE",
    "OBSERVATION DATE",
    "TIME OBSERVATIONS STARTED",
    "OBSERVER ID",
    "SAMPLING EVENT IDENTIFIER",
    "PROTOCOL TYPE",
    "PROTOCOL CODE",
    "PROJECT CODE",
    "DURATION MINUTES",
    "EFFORT DISTANCE KM",
    "EFFORT AREA HA",
    "NUMBER OBSERVERS",
    "ALL SPECIES REPORTED",
    "GROUP IDENTIFIER",
    "HAS MEDIA",
    "APPROVED",
    "REVIEWED",
    "REASON",
    "TRIP COMMENTS",
    "SPECIES COMMENTS",
    "PROTOCOL NAME",
  ];
  const rows = [[headers.join("\t")], [headers.join("\t")]];
  for (let checklist = 0; checklist < 180; checklist += 1) {
    const location = checklist % 12;
    const date = `2024-${String((checklist % 12) + 1).padStart(2, "0")}-${String(
      (checklist % 27) + 1,
    ).padStart(2, "0")}`;
    for (let index = 0; index < species.length; index += 1) {
      const [commonName, scientificName] = species[index];
      rows[checklist < 90 ? 0 : 1].push(
        [
          `URN:CornellLabOfOrnithology:EBIRD:OBS${checklist}-${index}`,
          "2024-12-31",
          index + 1,
          "species",
          commonName,
          scientificName,
          String((index % 4) + 1),
          "",
          "",
          "",
          "",
          "United States",
          "US",
          "California",
          "US-CA",
          `Perf County ${location % 3}`,
          `US-CA-${String(location % 3).padStart(3, "0")}`,
          `Perf Hotspot ${location}`,
          `L${String(location).padStart(4, "0")}`,
          "H",
          String(37.1 + location * 0.02),
          String(-122.1 - location * 0.02),
          date,
          "07:30:00",
          "obsr1",
          `S${String(checklist).padStart(6, "0")}`,
          "Traveling",
          "P22",
          "EBIRD",
          "45",
          "2.4",
          "",
          "1",
          checklist % 5 === 0 ? "0" : "1",
          "",
          "0",
          "1",
          "0",
          "",
          // Checklist and species comments, including one that opens with a double
          // quote: default CSV quoting would swallow every row that follows it.
          checklist % 7 === 0 ? `Gate closed before 07:00 on visit ${checklist}.` : "",
          index === 2 && checklist % 9 === 0
            ? '"Wheezy" two-note call, recorded.'
            : index % 5 === 0
              ? `Seen in the open at location ${location}.`
              : "",
          "Traveling",
        ].join("\t"),
      );
    }
  }
  await Promise.all(
    filePaths.map((filePath, index) => writeFile(filePath, rows[index].join("\n"), "utf8")),
  );
  return filePaths;
};

const getHeapMb = async (page, cdpSession) => {
  await cdpSession.send("HeapProfiler.collectGarbage");
  const heap = await cdpSession.send("Runtime.getHeapUsage").catch(() => null);
  if (heap?.usedSize) return heap.usedSize / 1024 / 1024;
  const memory = await page.evaluate(() => performance.memory?.usedJSHeapSize || 0);
  return memory / 1024 / 1024;
};

const showAllSpeciesRows = async (page) => {
  await page.locator('input[aria-label="Average trip (min)"]').evaluate((input) => {
    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.locator("tbody tr.species-row").first().waitFor({ state: "visible" });
};

// Most rows are milliseconds; a couple are not.
const unitFor = (key) => {
  if (key.includes("heap")) return " MB";
  return key.endsWith("Ms") ? " ms" : "";
};

const assertThreshold = (results, failures, key, actual) => {
  const limit = thresholds[key];
  const ok = actual <= limit;
  results.push({ key, actual, limit, ok });
  if (!ok) failures.push(`${key}: ${actual} > ${limit}`);
};

let preview;
let browser;

try {
  await run("npm", ["run", "build"]);

  const port = await findFreePort();
  const origin = `http://127.0.0.1:${port}`;
  preview = spawn(
    path.join(ROOT, "node_modules", ".bin", "vite"),
    ["preview", "--host", "127.0.0.1", "--port", String(port)],
    { cwd: ROOT, stdio: "pipe" },
  );
  await waitForServer(`${origin}${BASE_PATH}`);

  const ebdPaths = await createSyntheticEbd();
  const launchOptions = {
    headless: process.env.PERF_HEADFUL !== "1",
    args: ["--js-flags=--expose-gc"],
  };
  if (process.env.PERF_BROWSER_CHANNEL) {
    launchOptions.channel = process.env.PERF_BROWSER_CHANNEL;
  }
  try {
    browser = await chromium.launch(launchOptions);
  } catch (error) {
    if (process.env.PERF_BROWSER_CHANNEL) throw error;
    browser = await chromium.launch({ ...launchOptions, channel: "chrome" });
  }
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const cdpSession = await context.newCDPSession(page);
  const failures = [];
  const rows = [];

  const firstLoad = await timed("firstLoad", async () => {
    await page.goto(`${origin}${BASE_PATH}create`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Create from eBird data", exact: true }).waitFor({ state: "visible" });
  });
  assertThreshold(rows, failures, "firstLoadMs", firstLoad.ms);

  const ebdRead = await timed("ebdRead", async () => {
    await page.getByRole("button", { name: "Create from eBird data", exact: true }).click();
    await page.setInputFiles("#fileInput", ebdPaths);
    await page
      .getByText("Loaded 1,440 records into 180 checklists.")
      .waitFor({ timeout: thresholds.ebdReadMs + 3000 });
  });
  assertThreshold(rows, failures, "ebdReadMs", ebdRead.ms);

  const createTrip = await timed("createTrip", async () => {
    await page.getByLabel("Trip name", { exact: true }).fill("Performance test trip");
    await page.getByRole("button", { name: /^Create Trip$/ }).click();
    await page.getByRole("heading", { name: /^Targets for / }).waitFor({ timeout: thresholds.createTripMs + 5000 });
    await page.getByText("Total Species (EBD):").waitFor({ state: "visible" });
  });
  assertThreshold(rows, failures, "createTripMs", createTrip.ms);

  // Correctness, not speed: the comment corpus must exist, and a comment that
  // opens with a double quote must survive the parser intact.
  const corpus = await page.evaluate(async () => {
    const open = indexedDB.open("ebirdTripPlanner_v1");
    const db = await new Promise((resolve) => {
      open.onsuccess = () => resolve(open.result);
    });
    const stored = await new Promise((resolve) => {
      const request = db.transaction("comments").objectStore("comments").getAll();
      request.onsuccess = () => resolve(request.result);
    });
    const entries = stored[0]?.entries || [];
    return {
      entries: entries.length,
      checklistNotes: entries.filter((entry) => entry.checklist_comment).length,
      quoted: entries.some((entry) =>
        (entry.species_comments || []).some(([, text]) => text === '"Wheezy" two-note call, recorded.'),
      ),
    };
  });
  if (!corpus.entries || !corpus.checklistNotes || !corpus.quoted) {
    failures.push(`comment corpus wrong: ${JSON.stringify(corpus)}`);
  }
  rows.push({ key: "commentEntries", actual: corpus.entries, limit: "> 0", ok: corpus.entries > 0 });

  const heapBefore = await getHeapMb(page, cdpSession);

  const speciesListLoad = await timed("speciesListLoad", async () => {
    await page.getByRole("link", { name: "Species List" }).click();
    await page.getByRole("button", { name: /Species/ }).waitFor({ state: "visible" });
    await showAllSpeciesRows(page);
  });
  assertThreshold(rows, failures, "speciesListLoadMs", speciesListLoad.ms);

  const sortClick = await timed("sortClick", async () => {
    await page.getByRole("button", { name: /Species/ }).click();
    await page.locator("tbody tr.species-row").first().waitFor({ state: "visible" });
  });
  assertThreshold(rows, failures, "sortClickMs", sortClick.ms);

  const repeatedNavigation = await timed("repeatedNavigation", async () => {
    for (let index = 0; index < 12; index += 1) {
      await page.getByRole("link", { name: "Trips" }).click();
      await page.getByRole("button", { name: "Create from eBird data", exact: true }).waitFor({ state: "visible" });
      await page.getByRole("link", { name: "Species List" }).click();
      await showAllSpeciesRows(page);
    }
  });
  assertThreshold(rows, failures, "repeatedNavigationMs", repeatedNavigation.ms);

  const heapAfter = await getHeapMb(page, cdpSession);
  const heapGrowthMb = Math.round((heapAfter - heapBefore) * 10) / 10;
  assertThreshold(rows, failures, "heapGrowthMb", heapGrowthMb);

  console.table(
    rows.map((row) => ({
      metric: row.key,
      actual: `${row.actual}${unitFor(row.key)}`,
      limit: `${row.limit}${unitFor(row.key)}`,
      ok: row.ok,
    })),
  );

  if (failures.length) {
    throw new Error(`Performance thresholds exceeded:\n${failures.join("\n")}`);
  }
} finally {
  if (browser) await browser.close();
  if (preview) preview.kill("SIGTERM");
}
