import test from 'node:test';
import assert from 'node:assert/strict';
import { retainWorkspaceRoutes, routeArrivalTime } from '../../src/utils/workspaceRoutes.js';
import { workspaceModel, workspaceModelPlan } from '../../src/utils/workspaceModel.js';
import { buildWorkspacePlan, workspaceVisits } from '../../src/utils/workspacePlan.js';

const stops = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
const routes = new Map(
  stops.slice(1).map((stop) => [
    stop.id,
    {
      geometry: {
        type: 'LineString',
        coordinates: [
          [1, 2],
          [3, 4],
        ],
      },
      distance: 2000,
      duration: 120,
    },
  ]),
);

test('removing a middle stop preserves every unaffected driving leg and its data', () => {
  const retained = retainWorkspaceRoutes(
    stops,
    stops.filter((s) => s.id !== 'c'),
    routes,
  );
  assert.deepEqual([...retained.keys()], ['b', 'e']);
  assert.equal(retained.get('b'), routes.get('b'));
  assert.equal(retained.get('e'), routes.get('e'));
  assert.equal(routes.size, 4, 'the original routes remain available to undo');
});

test('removing the last stop keeps all earlier driving legs', () => {
  assert.deepEqual(
    [...retainWorkspaceRoutes(stops, stops.slice(0, -1), routes).keys()],
    ['b', 'c', 'd'],
  );
});

test('removing the first stop clears only the new first stop incoming route', () => {
  assert.deepEqual(
    [...retainWorkspaceRoutes(stops, stops.slice(1), routes).keys()],
    ['c', 'd', 'e'],
  );
});

test('bulk removal keeps surviving adjacent pairs', () => {
  assert.deepEqual(
    [
      ...retainWorkspaceRoutes(
        stops,
        stops.filter((s) => !['b', 'c'].includes(s.id)),
        routes,
      ).keys(),
    ],
    ['e'],
  );
  assert.equal(retainWorkspaceRoutes(stops, [], routes).size, 0);
});

test('date edits and bulk shifts preserve routes when order stays the same', () => {
  const shifted = stops.map((s) => ({ ...s, date: '2026-12-01T08:00' }));
  assert.deepEqual(retainWorkspaceRoutes(stops, shifted, routes), routes);
});

test('reordering keeps only legs with the same directed pair of stops', () => {
  const reordered = [stops[2], stops[3], stops[0], stops[1], stops[4]];
  assert.deepEqual([...retainWorkspaceRoutes(stops, reordered, routes).keys()], ['d', 'b']);
});

test('inserting a stop clears only the leg whose origin changed', () => {
  const inserted = [...stops.slice(0, 2), { id: 'new' }, ...stops.slice(2)];
  assert.deepEqual([...retainWorkspaceRoutes(stops, inserted, routes).keys()], ['b', 'd', 'e']);
  assert.deepEqual(retainWorkspaceRoutes(stops, [...stops, { id: 'new' }], routes), routes);
});

test('unaffected routes survive deleting a stop, saving locally and reopening the trip', () => {
  const plan = {
    version: 1,
    name: 'Route preservation',
    timeZone: '',
    reportId: '',
    stops: stops.map((stop, i) => ({
      id: stop.id,
      name: stop.id,
      type: 'birding',
      dateTime: `2026-11-13T0${i + 1}:00`,
      durationMinutes: 60,
      longitude: i,
      latitude: 0,
      radiusMeters: 1000,
      note: '',
      targetSpecies: [],
      routeGeometryJson: i ? JSON.stringify(routes.get(stop.id).geometry) : '',
      routeDistanceM: i ? routes.get(stop.id).distance : 0,
      routeDurationS: i ? routes.get(stop.id).duration : 0,
    })),
  };
  const model = workspaceModel(plan);
  const remaining = model.stops.filter((s) => s.id !== 'c');
  const retained = retainWorkspaceRoutes(model.stops, remaining, routes);
  const saved = workspaceModelPlan(plan, remaining, retained, '', new Map());
  const visits = workspaceVisits(saved, 'trip');
  const reopenedPlan = buildWorkspacePlan({ name: plan.name }, visits);
  assert.deepEqual(reopenedPlan, saved);
  const reopened = workspaceModel(reopenedPlan);
  assert.deepEqual(
    reopened.stops.map((s) => s.id),
    ['a', 'b', 'd', 'e'],
  );
  assert.deepEqual(reopened.stops.find((s) => s.id === 'b').route, routes.get('b'));
  assert.deepEqual(reopened.stops.find((s) => s.id === 'e').route, routes.get('e'));
  assert.deepEqual(reopened.stops.find((s) => s.id === 'd').route, {
    geometry: null,
    distance: 0,
    duration: 0,
  });
});

test('routing uses the trip clock for scheduled arrivals regardless of browser timezone', () => {
  assert.equal(routeArrivalTime('2026-11-21T07:00', 'America/Cancun'), '2026-11-21T12:00:00Z');
  assert.equal(routeArrivalTime('2026-02-16T10:00', 'Asia/Muscat'), '2026-02-16T06:00:00Z');
  assert.equal(routeArrivalTime('2026-07-21T07:00', 'Europe/Paris'), '2026-07-21T05:00:00Z');
});
