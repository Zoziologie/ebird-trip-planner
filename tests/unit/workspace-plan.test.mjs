import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorkspacePlan,
  workspaceVisits,
  samePlan,
  mergePlans,
  publicationDecision,
  datasetArchive,
  validatePlanSize,
} from '../../src/utils/workspacePlan.js';

const trip = {
  id: 'local',
  name: 'Oman',
  timeZone: 'Asia/Muscat',
  tripReportId: '468402',
  secret: 'private',
};
const visit = {
  id: 3,
  workspaceId: 'stop-a',
  longitude: 54,
  latitude: 17,
  name: 'Park',
  dateTime: '2026-02-16T06:00',
  durationMin: 1.5,
  radiusKm: 0.5,
  note: 'Meet at gate',
  targetSpecies: ['osprey'],
  statsSpeciesCounts: { osprey: 3 },
  routeGeometry: {
    type: 'LineString',
    coordinates: [
      [53, 17],
      [54, 17],
    ],
  },
  routeDurationS: 120,
  routeDistanceM: 2000,
};

test('shared plan allows only itinerary fields and round-trips legacy hours and kilometres exactly once', () => {
  const plan = buildWorkspacePlan(trip, [visit]);
  assert.equal(plan.stops[0].durationMinutes, 90);
  assert.equal(plan.stops[0].radiusMeters, 500);
  assert.equal(plan.stops[0].note, 'Meet at gate');
  assert.equal(plan.secret, undefined);
  assert.equal(plan.stops[0].statsSpeciesCounts, undefined);
  assert.equal(plan.stops[0].tripId, undefined);
  const restored = workspaceVisits(plan, 'other-local', [visit], 100);
  assert.equal(restored[0].id, 3);
  assert.equal(restored[0].workspaceId, 'stop-a');
  assert.equal(restored[0].durationMin, 1.5);
  assert.equal(restored[0].radiusKm, 0.5);
  assert.equal(samePlan(buildWorkspacePlan(trip, restored), plan), true);
  assert.deepEqual(restored[0].statsSpeciesCounts, { osprey: 3 });
  const moved = structuredClone(plan);
  moved.stops[0].latitude = 18;
  assert.equal(
    workspaceVisits(moved, 'other-local', [visit], 100)[0].statsSpeciesCounts,
    undefined,
  );
});

test('stable stop identity survives device-local IDs and new stops acquire a new local key', () => {
  const plan = buildWorkspacePlan(trip, [visit]);
  const restored = workspaceVisits(plan, 'second-device', [], 100);
  assert.equal(restored[0].id, undefined);
  assert.equal(restored[0].workspaceId, 'stop-a');
});

test('legacy trips do not silently inherit the planning device time zone', () => {
  assert.equal(buildWorkspacePlan({ name: 'Legacy Oman' }, [visit]).timeZone, '');
});

test('revision checks prevent stale overwrites while commit IDs recover lost acknowledgements', () => {
  const current = { revision: 'new', commitId: 'committed' };
  assert.equal(publicationDecision(current, 'old', 'next'), 'conflict');
  assert.equal(publicationDecision(current, 'new', 'next'), 'publish');
  assert.equal(publicationDecision(current, 'old', 'committed'), 'acknowledged');
});

test('dataset upload excludes the plan, personal lists and personal taxon flags without mutating the source', () => {
  const payload = {
    trip,
    visits: [visit],
    lists: [{ private: true }],
    ebd: {
      tripId: trip.id,
      locations: [],
      speciesList: [{ code: 'osprey', liferWorld: true, liferRegion: false, tripReportSeen: true }],
    },
    checklists: [],
    comments: [],
  };
  const dataset = datasetArchive(payload);
  assert.deepEqual(dataset.visits, []);
  assert.deepEqual(dataset.lists, []);
  assert.deepEqual(dataset.ebd.speciesList, [{ code: 'osprey' }]);
  assert.equal(dataset.trip.secret, undefined);
  assert.equal(payload.ebd.speciesList[0].liferWorld, true);
  assert.equal(payload.visits.length, 1);
});

test('oversize plans fail explicitly instead of discarding route geometry or device edits', () => {
  assert.doesNotThrow(() => validatePlanSize(buildWorkspacePlan(trip, [visit])));
  assert.throws(
    () => validatePlanSize({ note: 'x'.repeat(901 * 1024) }),
    /902 KiB.*900 KiB.*device edits are kept/,
  );
  assert.throws(() => validatePlanSize({ note: 'é'.repeat(460 * 1024) }), /921 KiB.*900 KiB/);
});

test('dense road routes comparable to Kenya fit without changing any coordinates', () => {
  const geometry = {
    type: 'LineString',
    coordinates: Array.from({ length: 33375 }, () => [36.123456, -1.123456]),
  };
  const plan = buildWorkspacePlan(trip, [{ ...visit, routeGeometry: geometry }]);
  assert.ok(new TextEncoder().encode(JSON.stringify(plan)).length > 700 * 1024);
  assert.doesNotThrow(() => validatePlanSize(plan));
  assert.deepEqual(workspaceVisits(plan, 'other-local')[0].routeGeometry, geometry);
});

const stop = (id, fields = {}) => ({
  id,
  name: id,
  type: 'birding',
  dateTime: '',
  durationMinutes: 60,
  longitude: 1,
  latitude: 2,
  radiusMeters: 500,
  note: '',
  targetSpecies: [],
  routeGeometryJson: '',
  routeDistanceM: 0,
  routeDurationS: 0,
  ...fields,
});
const plan = (stops, fields = {}) => ({
  version: 1,
  name: 'Trip',
  timeZone: '',
  reportId: '',
  stops,
  ...fields,
});
const names = (result) => Object.fromEntries(result.plan.stops.map((s) => [s.id, s.name]));

test('samePlan ignores derived stop order', () => {
  assert.equal(samePlan(plan([stop('a'), stop('b')]), plan([stop('b'), stop('a')])), true);
  assert.equal(samePlan(plan([stop('a')]), plan([stop('a', { note: 'x' })])), false);
});

test('mergePlans keeps edits to different stops and fields from both sides', () => {
  const base = plan([stop('a'), stop('b')]);
  const local = plan([stop('a', { name: 'A local' }), stop('b', { note: 'local note' })]);
  const remote = plan([stop('a', { note: 'remote note' }), stop('b', { name: 'B remote' })], {
    name: 'Renamed',
  });
  const result = mergePlans(base, local, remote);
  assert.equal(result.conflicts, 0);
  assert.equal(result.plan.name, 'Renamed');
  assert.deepEqual(names(result), { a: 'A local', b: 'B remote' });
  assert.equal(result.plan.stops.find((s) => s.id === 'a').note, 'remote note');
  assert.equal(result.plan.stops.find((s) => s.id === 'b').note, 'local note');
});

test('mergePlans keeps stops added on either side and honours deletions', () => {
  const base = plan([stop('a'), stop('b'), stop('c')]);
  const local = plan([stop('a'), stop('c'), stop('new-local')]);
  const remote = plan([stop('a'), stop('b'), stop('new-remote')]);
  const result = mergePlans(base, local, remote);
  assert.equal(result.conflicts, 0);
  assert.deepEqual(Object.keys(names(result)).sort(), ['a', 'new-local', 'new-remote']);
});

test('mergePlans keeps a stop one side deleted and the other edited', () => {
  const base = plan([stop('a')]);
  const result = mergePlans(base, plan([]), plan([stop('a', { note: 'still going' })]));
  assert.equal(result.conflicts, 1);
  assert.equal(result.plan.stops[0].note, 'still going');
});

test('mergePlans resolves same-field edits by preference and counts them', () => {
  const base = plan([stop('a')]);
  const local = plan([stop('a', { name: 'mine', longitude: 5, latitude: 6 })]);
  const remote = plan([stop('a', { name: 'theirs', latitude: 9 })]);
  const remoteWins = mergePlans(base, local, remote);
  assert.equal(remoteWins.conflicts, 2);
  assert.deepEqual(names(remoteWins), { a: 'theirs' });
  // Coordinates move as one unit, never as a mix of both positions.
  const merged = remoteWins.plan.stops[0];
  assert.deepEqual([merged.longitude, merged.latitude], [1, 9]);
  const localWins = mergePlans(base, local, remote, { prefer: 'local' });
  assert.deepEqual(names(localWins), { a: 'mine' });
  assert.deepEqual([localWins.plan.stops[0].longitude, localWins.plan.stops[0].latitude], [5, 6]);
});

test('mergePlans orders stops by date like buildWorkspacePlan', () => {
  const base = plan([]);
  const local = plan([stop('late', { dateTime: '2026-02-17T06:00' })]);
  const remote = plan([stop('early', { dateTime: '2026-02-16T06:00' })]);
  const result = mergePlans(base, local, remote);
  assert.deepEqual(
    result.plan.stops.map((s) => s.id),
    ['early', 'late'],
  );
});
