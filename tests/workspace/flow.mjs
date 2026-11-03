import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COLUMNS, makeRow } from '../unit/helpers/ebd-fixture.mjs';
import { chromium } from 'playwright';
import polyline from '@mapbox/polyline';

const port = 5189;
const base = `http://127.0.0.1:${port}/eBirdTripPlanner`;
const ebdFile = {
  name: 'tiny-ebd.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from(
    [COLUMNS, makeRow({ 'CHECKLIST COMMENTS': 'Library import comment' })]
      .map((row) => row.join('\t'))
      .join('\n'),
  ),
};
const testEnv = {
  ...process.env,
  WORKSPACE_TEST: 'true',
  VITE_FIREBASE_EMULATORS: 'true',
  VITE_FIREBASE_API_KEY: 'demo-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'demo-ebird-trip-planner.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'demo-ebird-trip-planner',
  VITE_FIREBASE_STORAGE_BUCKET: 'demo-ebird-trip-planner.appspot.com',
  VITE_FIREBASE_APP_ID: 'demo-app',
};
await new Promise((resolve, reject) => {
  const build = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
    stdio: 'inherit',
    env: testEnv,
  });
  build.on('exit', (code) =>
    code === 0 ? resolve() : reject(new Error(`Test build failed: ${code}`)),
  );
});
const harnessHtml = await readFile('dist/tests/workspace/harness.html', 'utf8');
const harnessUrl = `http://127.0.0.1:${port}${harnessHtml.match(/src="([^" ]+\.js)"/)[1]}`;
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
  { stdio: 'pipe', env: testEnv },
);
server.stderr.on('data', (data) => process.stderr.write(data));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, description, timeout = 30000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await delay(150);
  }
  throw new Error(`Timed out: ${description}`);
};
const chooseAlpha = async (page) => {
  const selected = page.getByRole('button', { name: 'Select Alpha stop', exact: true });
  if (await selected.count()) await selected.click();
  else await page.locator('.stop-list').getByText('Alpha stop', { exact: true }).click();
};
const openNotes = async (page) => {
  if ((await page.locator('#stop-extra-details').getAttribute('open')) === null)
    await page.locator('#stop-extra-details > summary').click();
  if ((await page.locator('#note-details').getAttribute('open')) === null)
    await page.locator('#note-details > summary').click();
};
const contexts = [];
let passed = false;
const context = async () => {
  const profile = await mkdtemp(join(tmpdir(), 'ebird-workspace-'));
  const browser = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    viewport: { width: 1440, height: 1000 },
  });
  await browser.addInitScript((url) => {
    window.workspaceHarnessReady = import(url);
  }, harnessUrl);
  await browser.route('https://tripreport.raphaelnussbaumer.com/**', async (route) => {
    const url = route.request().url();
    const json = url.includes('taxon-list')
      ? [
          {
            speciesCode: 'osprey',
            commonName: 'Osprey',
            sciName: 'Pandion haliaetus',
            category: 'species',
            numIndividuals: 2,
            numChecklists: 1,
          },
        ]
      : url.includes('taxon-detail')
        ? { checklists: [{ subId: 'S1', howMany: 2 }] }
        : [
            {
              subId: 'S1',
              locId: 'L1',
              loc: { name: 'Alpha stop', longitude: 54.1, latitude: 17.1, isHotspot: true },
              isoObsDate: '2026-02-16 06:00',
              numSpecies: 1,
            },
          ];
    await route.fulfill({ json });
  });
  contexts.push(browser);
  return browser;
};
const login = async (page, subject) =>
  page.evaluate(async (subject) => {
    await window.workspaceHarnessReady;
    const { initCloud, signInWithCredential, GoogleAuthProvider } = window.workspaceTest;
    const jwt = JSON.stringify({
      sub: subject,
      email: `${subject}@example.com`,
      email_verified: true,
      name: subject,
    });
    const { auth } = await initCloud();
    return (await signInWithCredential(auth, GoogleAuthProvider.credential(jwt))).user.uid;
  }, subject);
const state = (page) =>
  page.evaluate(async () => {
    await window.workspaceHarnessReady;
    const { db } = window.workspaceTest;
    const tripId = localStorage.getItem('selectedTripId');
    return {
      trip: await db.trips.get(tripId),
      sync: await db.workspaceSync.get(tripId),
      visits: await db.visits.where('tripId').equals(tripId).toArray(),
      recoveries: await db.workspaceRecovery.where('tripId').equals(tripId).toArray(),
    };
  });
const waitSaved = (page) =>
  until(
    async () =>
      (await page.getByRole('status').allTextContents()).some((text) => text === 'Saved to cloud'),
    'cloud acknowledgement',
  );
try {
  await until(async () => {
    try {
      return (await fetch(`${base}/`)).ok;
    } catch {
      return false;
    }
  }, 'Vite');
  console.log('Checking trip library creation, EBD import and backups…');
  // The new library is the landing page; all creation/import workflows use it.
  const libraryContext = await context();
  const libraryPage = libraryContext.pages()[0];
  const libraryErrors = [];
  libraryPage.on('pageerror', (error) => libraryErrors.push(error.message));
  await libraryPage.goto(`${base}/`);
  await libraryPage.getByRole('heading', { name: 'My trips', exact: true }).waitFor();
  await libraryPage.getByRole('button', { name: 'New trip', exact: true }).click();
  assert.equal(await libraryPage.locator('#new-trip-name').count(), 0);
  assert.equal(await libraryPage.locator('#new-trip-zone').count(), 0);
  assert.equal(
    await libraryPage.getByRole('button', { name: 'Create empty trip', exact: true }).count(),
    0,
  );
  assert.equal(
    await libraryPage.getByRole('button', { name: 'Create Trip', exact: true }).count(),
    0,
  );
  await libraryPage.locator('#fileInput').setInputFiles(ebdFile);
  assert.equal(
    await libraryPage.getByRole('button', { name: 'Create Trip', exact: true }).isEnabled(),
    false,
  );
  await libraryPage.locator('#new-trip-name').fill('EBD library trip');
  await libraryPage.locator('#yearMaxFilter').fill('1900');
  await libraryPage.getByRole('button', { name: 'Create Trip', exact: true }).click();
  await libraryPage.getByText(/No eBird locations match these filters/).waitFor();
  assert.equal(await libraryPage.evaluate(async () => window.workspaceTest.db.trips.count()), 0);
  await libraryPage.locator('#yearMaxFilter').fill('');
  await libraryPage.getByRole('button', { name: 'Create Trip', exact: true }).click();
  await libraryPage.getByRole('button', { name: '+ Stop', exact: true }).click();
  await until(async () => (await state(libraryPage)).visits.length === 1, 'EBD trip editing');
  assert.equal((await state(libraryPage)).trip.timeZone, '');
  await libraryPage.evaluate(async () => {
    const { db } = window.workspaceTest;
    const visit = (await db.visits.toArray())[0];
    await db.visits.update(visit.id, { latitude: 17, longitude: 54, dateTime: '2026-02-16T07:00' });
  });
  await libraryPage.reload();
  await libraryPage.getByRole('button', { name: 'Trip settings', exact: true }).click();
  await libraryPage.getByText('Advanced · time zone', { exact: true }).click();
  await libraryPage.getByText('Detected: Asia/Muscat', { exact: true }).waitFor();
  await libraryPage.locator('#workspace-time-zone').fill('Europe/Paris');
  await libraryPage.getByRole('button', { name: 'Save time zone', exact: true }).click();
  await until(
    async () => (await state(libraryPage)).trip.timeZone === 'Europe/Paris',
    'time zone override',
  );
  await libraryPage.locator('#workspace-time-zone').fill('');
  await libraryPage.getByRole('button', { name: 'Save time zone', exact: true }).click();
  await until(
    async () => (await state(libraryPage)).trip.timeZone === '',
    'automatic time zone reset',
  );
  assert.equal((await state(libraryPage)).visits[0].dateTime, '2026-02-16T07:00');
  await libraryPage.locator('#settings-close').click();
  await libraryPage.getByRole('link', { name: 'My trips', exact: true }).click();
  await libraryPage.getByRole('button', { name: 'New trip', exact: true }).click();
  await libraryPage.locator('#fileInput').setInputFiles(ebdFile);
  await libraryPage.locator('#new-trip-name').fill('Raw EBD library trip');
  await libraryPage.getByRole('button', { name: 'Create Trip', exact: true }).click();
  await libraryPage
    .getByRole('textbox', { name: 'Stop name', exact: true })
    .waitFor({ state: 'hidden' });
  await libraryPage.getByRole('link', { name: 'My trips', exact: true }).waitFor();
  const raw = await libraryPage.evaluate(async () => {
    await window.workspaceHarnessReady;
    const { db } = window.workspaceTest;
    const trip = (await db.trips.toArray()).find((t) => t.name === 'Raw EBD library trip');
    return { ebd: await db.ebd.get(trip.id), comments: await db.comments.get(trip.id) };
  });
  assert.equal(raw.ebd.locations.length, 1);
  assert.equal(raw.comments.entries[0].checklist_comment, 'Library import comment');
  await libraryPage.getByRole('link', { name: 'My trips', exact: true }).click();
  const rawCard = libraryPage.locator('.trip-card').filter({
    has: libraryPage.getByRole('heading', { name: 'Raw EBD library trip', exact: true }),
  });
  await rawCard.locator('summary').click();
  const backupDownload = libraryPage.waitForEvent('download');
  await rawCard.getByRole('button', { name: 'Download backup', exact: true }).click();
  const backupPath = await (await backupDownload).path();
  await libraryPage.getByRole('button', { name: 'Import backup', exact: true }).click();
  await libraryPage.locator('#trip-archive-input').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"unrelated":true}'),
  });
  await libraryPage.getByRole('alert').waitFor();
  assert.equal(
    await libraryPage.getByRole('button', { name: 'Import trip', exact: true }).count(),
    0,
  );
  await libraryPage.locator('#trip-archive-input').setInputFiles(backupPath);
  await libraryPage.getByRole('button', { name: 'Import trip', exact: true }).click();
  await libraryPage.getByRole('link', { name: 'My trips', exact: true }).waitFor();
  await libraryPage.getByRole('link', { name: 'My trips', exact: true }).click();
  await until(
    async () => (await libraryPage.locator('.trip-card').count()) === 3,
    'backup import keeps the original trip',
  );
  // Older JSON archives retain stop IDs, notes, targets and report links through import.
  const older = {
    version: 1,
    trip: {
      id: 'old-trip',
      name: 'Old saved trip',
      tripReportId: '468402',
      timeZone: 'Asia/Muscat',
    },
    visits: [
      {
        id: 1,
        name: 'Old stop',
        type: 'birding',
        dateTime: '2026-02-16T06:00',
        durationMin: 1,
        radiusKm: 0.5,
        longitude: 54.1,
        latitude: 17.1,
        note: 'Keep this note',
        targetSpecies: ['osprey'],
      },
    ],
    lists: [],
    checklists: [],
    comments: [],
  };
  older.workspaceReport = {
    reportId: '468402',
    updatedAt: 321,
    details: true,
    taxa: [
      {
        speciesCode: 'osprey',
        commonName: 'Osprey',
        sciName: 'Pandion haliaetus',
        category: 'species',
      },
    ],
    checklists: [
      {
        id: 'cached-S1',
        locId: 'L1',
        name: 'Old stop',
        coords: [54.1, 17.1],
        hotspot: true,
        date: '2026-02-16T06:00',
        species: { osprey: 2 },
      },
    ],
  };
  await libraryPage.getByRole('button', { name: 'Import backup', exact: true }).click();
  await libraryPage.locator('#trip-archive-input').setInputFiles({
    name: 'old.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(older)),
  });
  await libraryPage.getByRole('button', { name: 'Import trip', exact: true }).click();
  await libraryPage
    .getByRole('heading', { name: 'Add eBird data to start planning', exact: true })
    .waitFor();
  assert.equal(await libraryPage.getByRole('button', { name: '+ Stop', exact: true }).count(), 0);
  await libraryPage.locator('#fileInput').setInputFiles(ebdFile);
  await libraryPage.getByRole('button', { name: 'Add eBird data', exact: true }).click();
  await libraryPage.getByRole('textbox', { name: 'Stop name', exact: true }).waitFor();
  older.ebd = await libraryPage.evaluate(async () =>
    window.workspaceTest.db.ebd.get(localStorage.getItem('selectedTripId')),
  );
  const oldState = await state(libraryPage);
  assert.equal(oldState.visits[0].note, 'Keep this note');
  assert.deepEqual(oldState.visits[0].targetSpecies, ['osprey']);
  assert.equal(oldState.trip.tripReportId, '468402');
  assert.equal(
    await libraryPage.evaluate(
      async () => (await window.workspaceTest.db.workspaceReports.get('468402')).checklists[0].id,
    ),
    'cached-S1',
  );
  await libraryPage.goto(`${base}/speciesList`);
  await libraryPage.locator('#species-panel').waitFor();
  assert.equal(new URL(libraryPage.url()).pathname.endsWith('/workspace'), true);
  await libraryPage.goto(`${base}/create`);
  await libraryPage.getByRole('heading', { name: 'My trips', exact: true }).waitFor();
  await libraryPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await libraryPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await mkdir('output/playwright', { recursive: true });
  await libraryPage.screenshot({ path: 'output/playwright/trip-library-mobile-test.png' });
  assert.deepEqual(libraryErrors, []);
  await libraryPage.setViewportSize({ width: 1440, height: 1000 });
  console.log('Checking signed-in creation and old cloud archive migration…');
  await login(libraryPage, 'library-owner');
  await libraryPage.getByRole('button', { name: 'New trip', exact: true }).click();
  await libraryPage.locator('#fileInput').setInputFiles(ebdFile);
  await libraryPage.locator('#new-trip-name').fill('New cloud trip');
  await libraryPage.getByRole('button', { name: 'Create Trip', exact: true }).click();
  await waitSaved(libraryPage);
  assert.ok((await state(libraryPage)).sync.cloudId, 'signed-in creation enables autosave');
  assert.equal((await state(libraryPage)).trip.timeZone, '', 'EBD trips sync in automatic mode');
  // A full cloud allowance must leave the newly created local trip visible and explain why.
  await libraryPage.getByRole('link', { name: 'My trips', exact: true }).click();
  await libraryPage.getByRole('button', { name: 'New trip', exact: true }).click();
  await libraryPage.locator('#fileInput').setInputFiles(ebdFile);
  await libraryPage.locator('#new-trip-name').fill('Cloud quota fallback');
  await libraryPage.getByRole('button', { name: 'Create Trip', exact: true }).click();
  await libraryPage
    .getByRole('alert')
    .filter({ hasText: 'Your cloud allowance is full' })
    .waitFor();
  const fallbackCard = libraryPage.locator('.trip-card').filter({
    has: libraryPage.getByRole('heading', { name: 'Cloud quota fallback', exact: true }),
  });
  await fallbackCard.getByRole('button', { name: 'Open trip', exact: true }).click();
  await libraryPage.getByRole('button', { name: '+ Stop', exact: true }).click();
  await until(async () => (await state(libraryPage)).visits.length === 1, 'quota fallback editing');
  assert.equal((await state(libraryPage)).sync.cloudId, '');
  await libraryPage.getByRole('link', { name: 'My trips', exact: true }).click();
  await libraryPage.getByRole('button', { name: 'Import backup', exact: true }).click();
  await libraryPage.locator('#trip-archive-input').setInputFiles(backupPath);
  await libraryPage.getByRole('button', { name: 'Import trip', exact: true }).click();
  await libraryPage
    .getByRole('alert')
    .filter({ hasText: 'Your cloud allowance is full' })
    .waitFor();
  assert.equal(await libraryPage.locator('dialog[open]').count(), 0);
  // Signed-in users can also create and reopen trips entirely offline.
  await libraryPage.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await until(
    () => libraryPage.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    'library offline shell',
  );
  await libraryContext.setOffline(true);
  await libraryPage.getByRole('button', { name: 'New trip', exact: true }).click();
  await libraryPage.locator('#fileInput').setInputFiles(ebdFile);
  await libraryPage.locator('#new-trip-name').fill('Created offline');
  await libraryPage.getByRole('button', { name: 'Create Trip', exact: true }).click();
  await libraryPage.getByRole('button', { name: '+ Stop', exact: true }).click();
  await until(async () => (await state(libraryPage)).visits.length === 1, 'offline creation');
  await libraryPage.reload();
  await libraryPage.getByRole('textbox', { name: 'Stop name', exact: true }).waitFor();
  assert.equal((await state(libraryPage)).trip.name, 'Created offline');
  assert.equal((await state(libraryPage)).sync.cloudId, '');
  await libraryContext.setOffline(false);
  // An existing cloud archive opens intact and upgrades only through an explicit action.
  const legacyContext = await context();
  const legacyPage = legacyContext.pages()[0];
  await legacyPage.goto(`${base}/trips`);
  await login(legacyPage, 'legacy-owner');
  const legacyId = await legacyPage.evaluate(async (payload) => {
    const { saveCloudTrip, encodeTripArchive } = window.workspaceTest;
    const trip = await saveCloudTrip(await encodeTripArchive(payload), {
      name: payload.trip.name,
      localUpdatedAt: 1,
      visitCount: 1,
    });
    return trip.id;
  }, older);
  const legacyRevision = await legacyPage.evaluate(
    async (id) => (await window.workspaceTest.getCloudTrip(id)).revision,
    legacyId,
  );
  const legacyCard = legacyPage
    .locator('.trip-card')
    .filter({ has: legacyPage.getByRole('heading', { name: 'Old saved trip', exact: true }) });
  await legacyCard.getByRole('button', { name: 'Open trip', exact: true }).click();
  try {
    await legacyPage.getByRole('textbox', { name: 'Stop name', exact: true }).waitFor();
  } catch (error) {
    console.error(
      'Legacy open state',
      await legacyPage.evaluate(async () => ({
        text: document.body.innerText,
        selected: localStorage.getItem('selectedTripId'),
        trips: await window.workspaceTest.db.trips.toArray(),
        visits: await window.workspaceTest.db.visits.toArray(),
      })),
    );
    throw error;
  }
  assert.equal((await state(legacyPage)).visits[0].note, 'Keep this note');
  assert.equal(
    await legacyPage.evaluate(
      async (id) => (await window.workspaceTest.getCloudTrip(id)).revision,
      legacyId,
    ),
    legacyRevision,
    'opening preserves the old cloud file',
  );
  await legacyPage.getByRole('button', { name: 'Enable cloud autosave', exact: true }).click();
  await waitSaved(legacyPage);
  assert.equal((await state(legacyPage)).sync.basePlan.reportId, '468402');
  assert.equal((await state(legacyPage)).sync.basePlan.stops[0].note, 'Keep this note');
  console.log('Trip library checks passed; checking cloud and offline editing…');
  const ownerContext = await context();
  const page = ownerContext.pages()[0];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/workspace`);
  await login(page, 'workspace-owner');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await until(
    () => page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    'offline app shell activation',
  );
  await page.evaluate(async () => {
    await window.workspaceHarnessReady;
    const { db } = window.workspaceTest;
    const { refreshTrips, selectedTripId } = window.workspaceTest;
    const now = Date.now();
    await db.trips.put({
      id: 'workspace-test',
      name: 'Oman test',
      tripReportId: '468402',
      createdAt: now,
      updatedAt: now,
    });
    await db.ebd.put({
      tripId: 'workspace-test',
      updatedAt: now,
      region: { code: 'OM', name: 'Oman' },
      filters: {},
      speciesList: [
        {
          code: 'osprey',
          commonName: 'Osprey',
          scientificName: 'Pandion haliaetus',
          liferWorld: true,
          liferRegion: true,
          category: 'species',
        },
      ],
      locations: [
        {
          locality_id: 'L1',
          locality: 'Alpha stop',
          longitude: 54.1,
          latitude: 17.1,
          checklist_count: 10,
          species_checklist_counts: [['osprey', 5]],
          checklist_durations: [30],
          checklist_distances_km: [1],
        },
      ],
    });
    await db.visits.bulkAdd([
      {
        tripId: 'workspace-test',
        name: 'Alpha stop',
        dateTime: '2026-02-16T06:00',
        longitude: 54.1,
        latitude: 17.1,
        durationMin: 1.5,
        radiusKm: 0.5,
        note: 'Meet at gate',
        type: 'birding',
        targetSpecies: ['osprey'],
        updatedAt: now,
      },
      {
        tripId: 'workspace-test',
        name: 'Beta stop',
        dateTime: '2026-02-16T10:00',
        longitude: 54.15,
        latitude: 17.15,
        durationMin: 1,
        radiusKm: 0.5,
        note: '',
        type: 'birding',
        targetSpecies: [],
        updatedAt: now,
      },
    ]);
    await refreshTrips();
    selectedTripId.value = 'workspace-test';
  });
  await page.reload();
  await page.getByRole('button', { name: 'Enable cloud autosave', exact: true }).click();
  await waitSaved(page);
  assert.equal(
    (await state(page)).sync.basePlan.timeZone,
    '',
    'legacy trips sync without choosing a zone',
  );
  const roadGeometry = {
    type: 'LineString',
    coordinates: Array.from({ length: 2001 }, (_, i) => [
      Number((54.1 + i / 40000).toFixed(6)),
      Number((17.1 + i / 40000 + Math.sin((Math.PI * i) / 2000) / 2).toFixed(6)),
    ]),
  };
  await ownerContext.route('https://api.mapbox.com/directions/v5/**', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    assert.equal(query.get('overview'), 'full');
    assert.equal(query.get('geometries'), 'polyline6');
    await route.fulfill({
      json: {
        routes: [
          { geometry: polyline.fromGeoJSON(roadGeometry, 6), distance: 100000, duration: 99240 },
        ],
      },
    });
  });
  await page.getByRole('button', { name: 'Compute drive to Beta stop', exact: true }).click();
  await until(
    async () =>
      (await state(page)).visits.find((visit) => visit.name === 'Beta stop')?.routeDistanceM ===
      100000,
    'compact directions response',
  );
  const road = (await state(page)).visits.find((visit) => visit.name === 'Beta stop');
  assert.equal(road.routeDurationS, 99240);
  assert.ok(road.routeGeometry.coordinates.length < roadGeometry.coordinates.length / 2);
  assert.deepEqual(road.routeGeometry.coordinates[0], roadGeometry.coordinates[0]);
  assert.deepEqual(road.routeGeometry.coordinates.at(-1), roadGeometry.coordinates.at(-1));
  await waitSaved(page);
  assert.equal(await page.locator('.day').count(), 1, 'days without stops are omitted');
  assert.match(await page.locator('.day').innerText(), /Mon,? 16 Feb/);
  assert.match(await page.locator('.day').innerText(), /1d3h34min driving/);
  assert.equal(await page.locator('.day button, button.day').count(), 0);
  await page.locator('#datetime').fill('2026-02-18T06:00');
  await page.locator('#datetime').dispatchEvent('change');
  assert.equal(await page.locator('.day').count(), 2);
  assert.equal(await page.locator('.stop-row').count(), 2);
  assert.equal(await page.locator('.stop-row').first().isVisible(), true);
  assert.equal(await page.locator('.stop-row').last().isVisible(), true);
  assert.match(await page.locator('.day').last().innerText(), /Wed,? 18 Feb/);
  await page.locator('#datetime').fill('2026-02-16T06:00');
  await page.locator('#datetime').dispatchEvent('change');
  assert.equal(await page.getByLabel('Workspace trip', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Trip settings', exact: true }).click();
  assert.equal(await page.locator('#settings-dialog #life-upload').count(), 1);
  assert.equal(await page.locator('#settings-dialog #region-upload').count(), 1);
  assert.equal(await page.locator('#settings-dialog #report-link').isVisible(), true);
  assert.equal(await page.getByText('Download trip backup', { exact: true }).count(), 0);
  await page.getByLabel('Close settings', { exact: true }).click();
  await page.getByLabel('Stop type', { exact: true }).selectOption('Airport');
  assert.equal(await page.locator('#datetime').isVisible(), true);
  assert.equal(await page.locator('#note').isVisible(), true);
  for (const field of [
    'duration-field',
    'interest-details',
    'historical-stats',
    'recorded-stats',
    'comments-panel',
  ])
    assert.equal(await page.locator('#' + field).isVisible(), false, field + ' hidden for airport');
  await page.getByLabel('Stop type', { exact: true }).selectOption('Birding');
  assert.equal(await page.locator('#duration').isVisible(), true);
  await waitSaved(page);
  // Display choices move existing inputs without editing the shared itinerary.
  const displayPlan = (await state(page)).sync.basePlan;
  await page.getByRole('button', { name: 'Trip settings', exact: true }).click();
  await page.locator('#display-note-details').selectOption('default');
  await page.locator('#display-duration-field').selectOption('hidden');
  await page.getByLabel('Close settings', { exact: true }).click();
  assert.equal(await page.locator('#stop-default-body #note').isVisible(), true);
  assert.equal(await page.locator('#duration').isVisible(), false);
  assert.deepEqual((await state(page)).sync.basePlan, displayPlan);
  await page.reload();
  await page.locator('#stop-default-body #note').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#stop-default-body #note').isVisible(), true);
  assert.equal(await page.locator('#duration').isVisible(), false);
  await page.getByRole('button', { name: 'Trip settings', exact: true }).click();
  await page.getByRole('button', { name: 'Reset display preferences', exact: true }).click();
  await page.getByLabel('Close settings', { exact: true }).click();
  assert.equal(await page.locator('#duration').isVisible(), true);
  assert.equal(await page.locator('#redo').isVisible(), false);
  // Real geometry controls and undo persist through the reviewed interface.
  await page.getByRole('button', { name: 'Resize stop area north', exact: true }).press('ArrowUp');
  await until(
    async () => Math.abs((await state(page)).visits[0].radiusKm - 0.6) < 0.00001,
    'area handle persistence',
  );
  await page
    .getByRole('button', { name: 'Resize stop area north', exact: true })
    .press('ControlOrMeta+z');
  await until(async () => (await state(page)).visits[0].radiusKm === 0.5, 'geometry undo');
  assert.equal(await page.locator('#redo').isVisible(), true);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await until(
    async () => Math.abs((await state(page)).visits[0].radiusKm - 0.6) < 0.00001,
    'direct redo',
  );
  assert.equal(await page.locator('#redo').isVisible(), false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await until(async () => (await state(page)).visits[0].radiusKm === 0.5, 'direct undo');
  await page
    .locator('.stop-list')
    .getByText('Beta stop', { exact: true })
    .click({ modifiers: ['ControlOrMeta'] });
  await page.getByLabel('Shift amount', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Apply shift', exact: true }).click();
  await until(
    async () =>
      (await state(page)).visits[0].dateTime.endsWith('07:00') &&
      (await state(page)).visits[1].dateTime.endsWith('11:00'),
    'bulk time shift',
  );
  await page.getByLabel('Shift amount', { exact: true }).press('ControlOrMeta+z');
  await until(
    async () => (await state(page)).visits[0].dateTime.endsWith('06:00'),
    'bulk shift undo',
  );
  await chooseAlpha(page);
  const original = await state(page);
  const cloudId = original.sync.cloudId;
  assert.ok(cloudId);
  assert.equal(original.sync.basePlan.stops[0].durationMinutes, 90);
  // Real editor input -> IndexedDB -> compact cloud plan.
  await chooseAlpha(page);
  await openNotes(page);
  await page
    .getByRole('textbox', { name: 'Stop notes', exact: true })
    .fill('Saved through the editor');
  assert.equal(
    await page.locator('.app-header').count(),
    0,
    'the old app navigation must not surround the prototype',
  );
  assert.equal(await page.getByRole('separator', { name: 'Resize itinerary width' }).count(), 1);
  await until(
    async () => (await state(page)).sync.basePlan.stops[0].note === 'Saved through the editor',
    'edited note autosave',
  );
  assert.equal((await state(page)).sync.basePlan.stops.length, 2);
  assert.equal(
    (await state(page)).visits[1].updatedAt,
    original.visits[1].updatedAt,
    'editing one stop must not rewrite unrelated stops',
  );
  const datasetRevision = await page.evaluate(
    async (cloudId) => (await window.workspaceTest.getCloudTrip(cloudId)).revision,
    cloudId,
  );
  await page.getByRole('button', { name: 'Species', exact: true }).click();
  await page.getByText('Osprey', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await chooseAlpha(page);
  await page.getByRole('button', { name: 'Trip settings', exact: true }).click();
  await page.locator('#sync-report').click();
  await page.locator('#report-progress').getByText('Updated', { exact: true }).waitFor();
  await page.getByLabel('Close settings', { exact: true }).click();
  await openNotes(page);
  await page
    .locator('.recorded-stats')
    .getByText('1 checklists · 1 species seen', { exact: true })
    .waitFor();
  // The reporting-rate map runs its original computation in a worker.
  await page.locator('#layers > summary').click();
  await page.locator('#cluster-settings').click();
  await page.locator('#cluster-minimum').fill('1');
  await page.getByRole('button', { name: 'Compute reporting rates', exact: true }).click();
  await until(
    async () => /Osprey · 1 clusters/.test(await page.locator('#cluster-status').textContent()),
    'worker clustering result',
  );
  // Go offline, edit in the real form, switch views and reload without losing changes.
  await ownerContext.setOffline(true);
  await openNotes(page);
  await page.getByRole('textbox', { name: 'Stop notes', exact: true }).fill('Offline field edit');
  await until(
    async () => (await state(page)).visits[0].note === 'Offline field edit',
    'offline IndexedDB write',
  );
  await page.reload();
  await page.getByRole('textbox', { name: 'Stop name', exact: true }).waitFor();
  assert.equal((await state(page)).visits[0].note, 'Offline field edit');
  await page.getByRole('link', { name: 'My trips', exact: true }).click();
  await ownerContext.setOffline(false);
  await until(
    async () => (await state(page)).sync.basePlan.stops[0].note === 'Offline field edit',
    'offline reconnect sync',
  );
  await page
    .locator('.trip-card')
    .filter({
      has: page.getByRole('heading', { name: 'Oman test', exact: true }),
    })
    .getByRole('button', { name: 'Open trip', exact: true })
    .click();
  await page.getByRole('textbox', { name: 'Stop name', exact: true }).waitFor();
  assert.equal(
    await page.evaluate(
      async (cloudId) => (await window.workspaceTest.getCloudTrip(cloudId)).revision,
      cloudId,
    ),
    datasetRevision,
    'small edits must not re-upload the source dataset',
  );
  // A cloud-only backup must join the current plan with the source dataset.
  const cloudLibraryContext = await context();
  const cloudLibraryPage = cloudLibraryContext.pages()[0];
  await cloudLibraryPage.goto(`${base}/trips`);
  await login(cloudLibraryPage, 'workspace-owner');
  const cloudCard = cloudLibraryPage
    .locator('.trip-card')
    .filter({ has: cloudLibraryPage.getByRole('heading', { name: 'Oman test', exact: true }) });
  await cloudCard.locator('summary').click();
  const cloudBackupDownload = cloudLibraryPage.waitForEvent('download');
  await cloudCard.getByRole('button', { name: 'Download backup', exact: true }).click();
  const cloudBackup = JSON.parse(
    gunzipSync(await readFile(await (await cloudBackupDownload).path())).toString(),
  );
  assert.equal(cloudBackup.visits.length, 2, 'cloud backup includes the live itinerary');
  assert.equal(cloudBackup.visits[0].note, 'Offline field edit');
  assert.equal(cloudBackup.trip.tripReportId, '468402');
  // Public sharing uses only the plan; anonymous viewers never fetch an archive.
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByLabel('Anyone with the link can view').check();
  await page.getByLabel('Invited editor Google emails').fill('workspace-editor@example.com');
  await page.getByRole('button', { name: 'Save sharing settings', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const visitorContext = await context();
  const visitor = visitorContext.pages()[0];
  const visitorRequests = [];
  visitor.on('request', (request) => visitorRequests.push(request.url()));
  await visitor.goto(`${base}/workspace?cloud=${cloudId}`);
  await visitor.getByText('visitor view', { exact: true }).waitFor();
  await visitor.locator('.stop-list').getByText('Alpha stop', { exact: true }).click();
  await visitor.getByText('Offline field edit', { exact: true }).waitFor();
  assert.equal(
    visitorRequests.some((url) => url.includes('.ebirdtrip')),
    false,
  );
  assert.equal(await visitor.getByRole('button', { name: 'Sync', exact: true }).count(), 0);
  await visitor.getByRole('button', { name: 'Trip settings', exact: true }).click();
  assert.equal(await visitor.locator('#report-link').isVisible(), false);
  assert.equal(await visitor.locator('#display-note-details').isVisible(), false);
  assert.equal(await visitor.locator('#map-style').isVisible(), true);
  await visitor.getByLabel('Close settings', { exact: true }).click();
  await visitor.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await until(
    () => visitor.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    'visitor offline shell',
  );
  await visitorContext.setOffline(true);
  await visitor.reload();
  await visitor.getByText('visitor view', { exact: true }).waitFor();
  await visitor.locator('.stop-list').getByText('Alpha stop', { exact: true }).click();
  await visitor.getByText('Offline field edit', { exact: true }).waitFor();
  await visitorContext.setOffline(false);
  // Invited editor has a separate device and personal lists are absent in its dataset.
  const editorContext = await context();
  const editor = editorContext.pages()[0];
  await editor.goto(`${base}/workspace`);
  await login(editor, 'workspace-editor');
  await editor.goto(`${base}/workspace?cloud=${cloudId}&edit=1`);
  await editor.getByRole('textbox', { name: 'Stop name', exact: true }).waitFor();
  assert.equal(
    await editor.evaluate(() => window.workspaceTest.db.trips.count()),
    1,
    'one shared device copy',
  );
  await editor.reload();
  await editor.getByRole('textbox', { name: 'Stop name', exact: true }).waitFor();
  assert.equal(
    await editor.evaluate(() => window.workspaceTest.db.trips.count()),
    1,
    'editing link reuses the device copy',
  );
  assert.equal(
    await editor.evaluate(async () => {
      await window.workspaceHarnessReady;
      const { db } = window.workspaceTest;
      return (await db.ebd.get(localStorage.getItem('selectedTripId'))).speciesList[0].liferWorld;
    }),
    undefined,
  );
  await ownerContext.setOffline(true);
  await chooseAlpha(page);
  await openNotes(page);
  await page.getByRole('textbox', { name: 'Stop notes', exact: true }).fill('My offline conflict');
  await chooseAlpha(editor);
  await openNotes(editor);
  await editor
    .getByRole('textbox', { name: 'Stop notes', exact: true })
    .fill('Co-traveler cloud edit');
  await until(
    async () => (await state(editor)).sync.basePlan.stops[0].note === 'Co-traveler cloud edit',
    'second editor save',
  );
  await ownerContext.setOffline(false);
  await until(async () => (await state(page)).recoveries.length === 1, 'conflict recovery copy');
  const conflict = await state(page);
  assert.equal(conflict.recoveries[0].plan.stops[0].note, 'My offline conflict');
  assert.equal(conflict.visits[0].note, 'Co-traveler cloud edit');
  await page.getByRole('button', { name: /^Review / }).click();
  await page.getByText('My offline conflict', { exact: true }).waitFor();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download recovery copy', exact: true }).click();
  assert.match((await downloadPromise).suggestedFilename(), /trip-recovery/);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  // A lost acknowledgement must not produce a false recovery or duplicate revision.
  await page.evaluate(async () => {
    await window.workspaceHarnessReady;
    const { db } = window.workspaceTest;
    const { publishWorkspacePlan } = window.workspaceTest;
    const tripId = localStorage.getItem('selectedTripId');
    const state = await db.workspaceSync.get(tripId);
    const plan = structuredClone(state.basePlan);
    plan.stops[0].note = 'Commit whose acknowledgement was lost';
    const commitId = crypto.randomUUID();
    await db.transaction('rw', db.trips, db.visits, db.workspaceSync, async () => {
      const { applyWorkspacePlan } = window.workspaceTest;
      await applyWorkspacePlan(tripId, plan);
      await db.workspaceSync.update(tripId, { pending: { commitId, plan } });
    });
    await publishWorkspacePlan(state.cloudId, state.revision, commitId, plan);
  });
  await page.getByRole('button', { name: 'Sync', exact: true }).click();
  await until(
    async () =>
      (await state(page)).sync.basePlan.stops[0].note === 'Commit whose acknowledgement was lost',
    'lost-ack recovery',
  );
  assert.equal((await state(page)).recoveries.length, 1);
  await page.reload();
  await page.getByRole('button', { name: /^Review / }).waitFor();
  await mkdir('output/playwright', { recursive: true });
  await page.screenshot({ path: 'output/playwright/workspace-editor.png', fullPage: true });
  await visitor.setViewportSize({ width: 390, height: 844 });
  await visitor.reload();
  await visitor.getByText('visitor view', { exact: true }).waitFor();
  assert.equal(
    await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await visitor.screenshot({
    path: 'output/playwright/workspace-visitor-mobile.png',
    fullPage: true,
  });
  // Revocation blocks the cloud, but must not hide an existing device copy.
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByLabel('Anyone with the link can view').uncheck();
  await page.getByLabel('Invited editor Google emails').fill('');
  await page.getByRole('button', { name: 'Save sharing settings', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await visitor.reload();
  await visitor.getByRole('alert').waitFor();
  assert.equal(await visitor.getByText('visitor view', { exact: true }).count(), 0);
  await editor.goto(`${base}/trips`);
  await editor
    .locator('.trip-card')
    .filter({
      has: editor.getByRole('heading', { name: 'Oman test', exact: true }),
    })
    .getByRole('button', { name: 'Open trip', exact: true })
    .click();
  await editor.getByRole('textbox', { name: 'Stop name', exact: true }).waitFor();
  await chooseAlpha(editor);
  await openNotes(editor);
  await editor
    .getByRole('textbox', { name: 'Stop notes', exact: true })
    .fill('Kept after revocation');
  await until(
    async () => (await state(editor)).visits[0].note === 'Kept after revocation',
    'revoked device copy remains editable',
  );
  assert.deepEqual(errors, []);
  passed = true;
  console.log(
    'Workspace browser flow passed: migration, editor autosave, species view, offline edit/reload/reconnect, immutable dataset, visitor access, co-traveler conflict recovery, download and lost acknowledgements.',
  );
} catch (error) {
  console.error(error);
  throw error;
} finally {
  if (!passed) {
    await mkdir('output/playwright', { recursive: true });
    for (const [index, browser] of contexts.entries())
      await browser
        .pages()[0]
        ?.screenshot({ path: `output/playwright/transition-failure-${index}.png` })
        .catch(() => {});
  }
  await Promise.all(contexts.map((context) => context.close()));
  server.kill('SIGTERM');
}
