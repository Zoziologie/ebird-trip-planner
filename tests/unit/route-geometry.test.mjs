import test from 'node:test';
import assert from 'node:assert/strict';
import { distance, toMercator, toWgs84, pointToLineDistance } from '@turf/turf';
import { compactRouteGeometry } from '../../src/utils/routeGeometry.js';
import { buildWorkspacePlan, workspaceVisits } from '../../src/utils/workspacePlan.js';

test('access roads stay exact while long drives remain within the middle-line tolerance', () => {
  for (const latitude of [0, 70]) {
    const y = toMercator([0, latitude])[1];
    const geometry = {
      type: 'LineString',
      coordinates: Array.from({ length: 1001 }, (_, i) =>
        toWgs84([i * 100, y + 350 * Math.sin(i / 65) + 8 * Math.sin(i * 2)]),
      ),
    };
    const original = structuredClone(geometry);
    const compact = compactRouteGeometry(geometry);
    assert.ok(compact.coordinates.length < geometry.coordinates.length / 2);
    assert.deepEqual(geometry, original);
    assert.deepEqual(compactRouteGeometry(compact), compact);

    const along = [0];
    for (let i = 1; i < geometry.coordinates.length; i++)
      along.push(
        along[i - 1] +
          distance(geometry.coordinates[i - 1], geometry.coordinates[i], { units: 'meters' }),
      );
    const kept = new Set(compact.coordinates.map((coordinate) => JSON.stringify(coordinate)));
    for (const [i, coordinate] of geometry.coordinates.entries()) {
      if (along[i] <= 5000 || along.at(-1) - along[i] <= 5000)
        assert.ok(kept.has(JSON.stringify(coordinate)), 'every access-road vertex is kept');
      assert.ok(
        pointToLineDistance(coordinate, compact, { method: 'planar', units: 'meters' }) <= 25.1,
      );
    }
    assert.deepEqual(
      compactRouteGeometry({ type: 'LineString', coordinates: geometry.coordinates.slice(0, 80) })
        .coordinates,
      geometry.coordinates.slice(0, 80),
    );
  }
});

test('date-line crossings compact continuously and keep their endpoints', () => {
  const geometry = {
    type: 'LineString',
    coordinates: Array.from({ length: 1001 }, (_, i) => [
      ((179.8 + i / 1000 + 180) % 360) - 180,
      Math.sin(i / 50) / 1000,
    ]),
  };
  const compact = compactRouteGeometry(geometry);
  assert.ok(compact.coordinates.length < geometry.coordinates.length / 3);
  assert.deepEqual(compact.coordinates[0], geometry.coordinates[0]);
  assert.deepEqual(compact.coordinates.at(-1), geometry.coordinates.at(-1));
  assert.deepEqual(compactRouteGeometry(compact), compact);
});

test('existing routes compact without changing route distance, time or source data', () => {
  const visit = {
    workspaceId: 'road',
    latitude: 0,
    longitude: 0,
    routeDistanceM: 123456,
    routeDurationS: 7200,
    routeGeometry: {
      type: 'LineString',
      coordinates: Array.from({ length: 1001 }, (_, i) => [i / 1000, Math.sin(i / 50) / 1000]),
    },
  };
  const plan = buildWorkspacePlan({ name: 'Road trip' }, [visit]);
  const restored = workspaceVisits(plan, 'restored')[0];
  assert.ok(restored.routeGeometry.coordinates.length < visit.routeGeometry.coordinates.length / 3);
  assert.equal(visit.routeGeometry.coordinates.length, 1001);
  assert.equal(restored.routeDistanceM, 123456);
  assert.equal(restored.routeDurationS, 7200);
  assert.deepEqual(buildWorkspacePlan({ name: 'Road trip' }, [restored]), plan);
});
