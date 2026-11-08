import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceModel, workspaceModelPlan } from '../../src/utils/workspaceModel.js';
import {
  normalizeWorkspaceReportId,
  loadWorkspaceReport,
} from '../../src/utils/workspaceReport.js';

const plan = {
  version: 1,
  name: 'Oman',
  timeZone: 'Asia/Muscat',
  reportId: '',
  stops: [
    {
      id: 'uuid',
      name: 'Park',
      type: 'birding',
      dateTime: '2026-02-16T06:00',
      durationMinutes: 90,
      longitude: 54,
      latitude: 17,
      radiusMeters: 500,
      note: 'Meet at gate',
      targetSpecies: ['osprey', 'unresolved-code'],
      routeGeometryJson: '{"type":"LineString","coordinates":[[53,17],[54,17]]}',
      routeDistanceM: 2000,
      routeDurationS: 120,
    },
  ],
};

test('prototype presentation round-trips real stop IDs, target codes, hours, radius and route without changing the plan', () => {
  const model = workspaceModel(plan, {
    speciesList: [{ code: 'osprey', commonName: 'Osprey', scientificName: 'Pandion haliaetus' }],
    locations: [],
  });
  assert.deepEqual(model.stops[0].targets, ['Osprey', 'unresolved-code']);
  assert.equal(model.stops[0].duration, 1.5);
  assert.equal(model.stops[0].radius, 0.5);
  assert.equal(model.taxa[0].life, null);
  const routes = new Map(model.stops.map((s) => [s.id, s.route]));
  assert.deepEqual(
    workspaceModelPlan(plan, model.stops, routes, '', new Map(model.taxa.map((t) => [t.code, t]))),
    plan,
  );
});

test('EBD adapter preserves complete-checklist probability denominators separately from total count and supports both archive formats', () => {
  const model = workspaceModel(plan, {
    speciesList: [],
    locations: [
      {
        locality_id: 'L1',
        locality: 'Park',
        longitude: 54,
        latitude: 17,
        checklist_count: 12,
        checklist_count_complete: 10,
        species_checklist_counts: [['osprey', 5]],
        checklist_durations: [30],
        checklist_distances_km: [1],
      },
      {
        locality_id: 'L2',
        longitude: 55,
        latitude: 18,
        checklist_count: 2,
        species_checklist_counts: [],
        checklist: [{ duration_minutes: 60, effort_distance_km: 2 }],
      },
    ],
  });
  assert.equal(model.ebdLocations[0].count, 10);
  assert.equal(model.ebdLocations[0].totalCount, 12);
  assert.deepEqual(model.ebdLocations[1].durations, [60]);
  assert.deepEqual(model.ebdLocations[1].distances, [2]);
});

test('report input accepts any numeric eBird report and rejects unrelated URLs', () => {
  assert.equal(normalizeWorkspaceReportId(' https://ebird.org/tripreport/468403/ '), '468403');
  assert.equal(normalizeWorkspaceReportId('123'), '123');
  assert.throws(() => normalizeWorkspaceReportId('https://example.com/468402'));
});

test('report sync joins observations by checklist ID and retains missing species details as unknown', async (t) => {
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(url);
    const payload = url.includes('taxon-list')
      ? [{ speciesCode: 'osprey', commonName: 'Osprey' }]
      : url.includes('taxon-detail')
        ? {
            checklists: [
              { subId: 'S1', howMany: 2 },
              { subId: 'unrelated', howMany: 9 },
            ],
          }
        : ['S1', 'S2'].map((subId) => ({
            subId,
            locId: 'L1',
            loc: { name: 'Park', longitude: 54, latitude: 17, isHotspot: true },
            isoObsDate: '2026-02-16 06:00',
            numSpecies: 1,
          }));
    return { ok: true, json: async () => payload };
  });
  const report = await loadWorkspaceReport('468403', { details: true });
  assert.deepEqual(report.checklists[0].species, { osprey: 2 });
  assert.deepEqual(report.checklists[1].species, {});
  assert.equal(report.checklists[0].date, '2026-02-16T06:00');
  assert.equal(requested.length, 3);
});

test('legacy embedded observer comments remain available without copying malformed trailing EBD rows', () => {
  const model = workspaceModel(plan, {
    speciesList: [],
    locations: [
      {
        locality_id: 'L1',
        species_checklist_counts: [],
        checklist_count: 1,
        checklist: [
          {
            checklist_id: 'S1',
            date: '2026-02-16',
            species: [
              {
                code: 'osprey',
                species_comment: 'Fishing\nURN:CornellLabOfOrnithology:bad trailing data',
              },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(model.comments[0].checklist_id, 'S1');
  assert.deepEqual(model.comments[0].species_comments, [['osprey', 'Fishing']]);
});
