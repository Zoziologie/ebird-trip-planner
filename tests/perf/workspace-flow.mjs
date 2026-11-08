// Production workspace benchmark: real rendering, IndexedDB saves, and Mapbox sources.
// PERF_ARCHIVE=/path/to/trip.json runs the same checks on a private archive in an isolated profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const port = 5191,
  base = `http://127.0.0.1:${port}/ebird-trip-planner`;
const env = { ...process.env, WORKSPACE_TEST: 'true' };
const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...args], {
      env,
      stdio: 'inherit',
    });
    child.on('exit', (code) => (code ? reject(Error(`Vite exited ${code}`)) : resolve()));
  });
await run(['build']);
const html = await readFile('dist/tests/workspace/harness.html', 'utf8');
const harnessUrl = `http://127.0.0.1:${port}${html.match(/src="([^" ]+\.js)"/)[1]}`;
const server = spawn(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  { env, stdio: 'ignore' },
);
let browser;
const profile = await mkdtemp(join(tmpdir(), 'ebird-workspace-perf-'));
const results = [];
try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/`)).ok) break;
    } catch {
      /* Preview server is still starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browser = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: ['--js-flags=--expose-gc'],
  });
  await browser.addInitScript((url) => {
    window.workspaceHarnessReady = import(url);
  }, harnessUrl);
  // Keep map data processing/rendering real, remove internet and tile timing from the benchmark.
  await browser.route('https://api.mapbox.com/**', (route) =>
    route.fulfill({
      json: route.request().url().includes('/styles/')
        ? {
            version: 8,
            sources: {},
            layers: [
              { id: 'background', type: 'background', paint: { 'background-color': '#e5ece6' } },
            ],
          }
        : {},
    }),
  );
  const page = browser.pages()[0];
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error('Page error:', error.message);
  });
  const cdp = await browser.newCDPSession(page);
  const scales = process.env.PERF_ARCHIVE
    ? [0]
    : (process.env.PERF_SCALES || '1,2,4').split(',').map(Number);
  for (const scale of scales) {
    await page.goto(`${base}/tests/workspace/harness.html`);
    const archive = process.env.PERF_ARCHIVE
      ? JSON.parse(await readFile(process.env.PERF_ARCHIVE, 'utf8'))
      : null;
    const shape = await page.evaluate(
      async ({ scale, archive }) => {
        await window.workspaceHarnessReady;
        const { db } = window.workspaceTest;
        const id = 'perf-workspace',
          now = Date.now();
        let trip, ebd, visits, comments;
        if (archive) {
          ({ trip, ebd, visits } = archive);
          comments = archive.comments || [];
        } else {
          const n = Math.round(33370 * scale);
          trip = { name: `${scale}x workspace`, timeZone: 'Asia/Muscat' };
          const speciesList = Array.from({ length: 506 }, (_, i) => ({
            code: `sp${i}`,
            commonName: `Species ${String(i).padStart(3, '0')}`,
            scientificName: `Taxon ${i}`,
            category: 'species',
            liferWorld: i % 3 === 0,
            taxonOrder: i,
          }));
          visits = Array.from({ length: 63 }, (_, i) => ({
            workspaceId: crypto.randomUUID(),
            name: `Stop ${i}`,
            type: i % 9 === 8 ? 'accommodation' : 'birding',
            dateTime: `2026-02-${String(6 + Math.floor(i / 3)).padStart(2, '0')}T${String(6 + (i % 3) * 4).padStart(2, '0')}:00`,
            durationMin: 1.5,
            radiusKm: 2,
            longitude: 54 + (i % 9) * 0.15,
            latitude: 17 + Math.floor(i / 9) * 0.15,
            note: i === 0 ? 'Initial note' : '',
            targetSpecies: ['sp1'],
            routeGeometry: i
              ? {
                  type: 'LineString',
                  coordinates: Array.from({ length: 450 }, (_, j) => [
                    54 + ((i - 1 + j / 450) % 9) * 0.15,
                    17 + Math.floor(i / 9) * 0.15,
                  ]),
                }
              : null,
            routeDistanceM: 20000,
            routeDurationS: 1200,
          }));
          const locations = Array.from({ length: n }, (_, i) => {
            const stop = visits[i % 63];
            return {
              locality_id: `L${i}`,
              locality: `Location ${i}`,
              longitude: stop.longitude + Math.sin(i * 13) * 0.12,
              latitude: stop.latitude + Math.cos(i * 19) * 0.12,
              locality_hotspot: i % 67 === 0,
              checklist_count: 5,
              checklist_count_complete: 4,
              species_checklist_counts: Array.from({ length: 50 }, (_, j) => [
                `sp${(i * 7 + j * 3) % 506}`,
                1 + (j % 4),
              ]),
              checklist_durations: [20, 35, 45, 60],
              checklist_distances_km: [0.2, 0.5, 1, 2],
            };
          });
          ebd = { speciesList, locations };
          comments = locations
            .filter((_, i) => i % 5 === 0)
            .map((l, i) => ({
              locality_id: l.locality_id,
              checklist_id: `C${i}`,
              date: '2026-02-16',
              species_comments: [['sp1', 'Observed near the gate.']],
            }));
        }
        await db.trips.put({ ...trip, id, tripReportId: '123', updatedAt: now });
        await db.ebd.put({ ...ebd, tripId: id });
        await db.comments.put({ tripId: id, entries: comments });
        await db.visits.where('tripId').equals(id).delete();
        await db.visits.bulkAdd(visits.map(({ id: old, ...visit }) => ({ ...visit, tripId: id })));
        await db.workspaceReports.put({
          reportId: '123',
          taxa: [],
          details: true,
          checklists: Array.from({ length: 353 }, (_, i) => ({
            id: `S${i}`,
            locId: `L${i}`,
            name: 'Report checklist',
            coords: [visits[i % visits.length].longitude, visits[i % visits.length].latitude],
            date: '2026-02-16T08:00',
            species: Object.fromEntries(ebd.speciesList.slice(0, 30).map((t) => [t.code, 1])),
            declaredSpecies: 30,
            hotspot: true,
          })),
        });
        localStorage.setItem('selectedTripId', id);
        return {
          locations: ebd.locations.length,
          stops: visits.length,
          taxa: ebd.speciesList.length,
        };
      },
      { scale, archive },
    );
    const started = performance.now();
    await page.goto(`${base}/workspace`);
    await page.locator('#name').waitFor({ timeout: 120000 });
    await page
      .locator('.mapboxgl-marker.stop-symbol')
      .first()
      .waitFor({ state: 'attached', timeout: 30000 });
    const openMs = Math.round(performance.now() - started);
    await page.waitForTimeout(500);
    const measure = async (action) =>
      page.evaluate(async (action) => {
        const start = performance.now();
        if (action === 'note') {
          const input = document.querySelector('#note');
          input.value = `Performance note ${(window.perfNote = (window.perfNote || 0) + 1)}`;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (action === 'select')
          [...document.querySelectorAll('.stop-button')]
            .find(
              (b) => b.querySelector('.bi-feather') && b.getAttribute('aria-pressed') !== 'true',
            )
            .click();
        if (action === 'species') document.querySelector('#species-view').click();
        if (action === 'sort') document.querySelector('[data-sort="name"]').click();
        if (action === 'radius')
          document
            .querySelector('[aria-label="Resize stop area north"]')
            .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        if (action === 'fullTrip') document.querySelector('#full-trip').click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return Math.round(performance.now() - start);
      }, action);
    const marker = await page.locator('.mapboxgl-marker.stop-symbol').first().elementHandle();
    const noteSamples = [];
    for (let i = 0; i < 5; i++) noteSamples.push(await measure('note'));
    assert.ok(await marker.evaluate((el) => el.isConnected), 'Typing must preserve map markers');
    const selectMs = await measure('select'),
      radiusMs = await measure('radius'),
      speciesMs = await measure('species'),
      sortMs = await measure('sort'),
      fullTripMs = await measure('fullTrip');
    await page.waitForFunction(async () => {
      const { db } = window.workspaceTest;
      return (await db.visits.where('tripId').equals('perf-workspace').toArray()).some((v) =>
        v.note?.startsWith('Performance note'),
      );
    });
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const result = {
      dataset: archive ? 'private archive' : `${scale}x`,
      ...shape,
      openMs,
      noteMaxMs: Math.max(...noteSamples),
      selectMs,
      radiusMs,
      speciesMs,
      sortMs,
      fullTripMs,
      heapMb: Math.round(heap.usedSize / 1024 / 1024),
    };
    results.push(result);
    console.table([result]);
    if (process.env.PERF_ENFORCE !== '0') {
      assert.ok(openMs < 10000, 'Workspace opens within 10 seconds');
      for (const key of ['noteMaxMs', 'selectMs', 'radiusMs', 'speciesMs', 'sortMs', 'fullTripMs'])
        assert.ok(
          result[key] < Number(process.env.PERF_INTERACTION_MS || 250),
          `${key}: ${result[key]}ms exceeds interaction budget`,
        );
      assert.ok(result.heapMb < 400, 'Post-import workspace heap stays below 400 MB');
    }
  }
  assert.deepEqual(errors, []);
} catch (error) {
  if (browser) {
    const p = browser.pages()[0];
    console.error((await p.locator('body').innerText()).slice(0, 1500));
    await p.screenshot({ path: 'output/playwright/workspace-performance-error.png' });
  }
  throw error;
} finally {
  await mkdir('output/playwright', { recursive: true });
  await writeFile(
    process.env.PERF_RESULT || 'output/playwright/workspace-performance.json',
    JSON.stringify(results, null, 2),
  );
  await browser?.close();
  server.kill('SIGTERM');
  await rm(profile, { recursive: true, force: true });
}
