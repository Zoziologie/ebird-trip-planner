import test from 'node:test';
import assert from 'node:assert/strict';
import { distance, destination } from '@turf/turf';
import { workspaceSpatialIndex } from '../../src/utils/workspaceSpatial.js';

test('indexed areas match exact spherical membership, including date line and poles', () => {
  let seed = 42;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const locations = Array.from({ length: 20000 }, (_, id) => ({
    id,
    coords: [random() * 360 - 180, random() * 180 - 90],
  }));
  for (const center of [
    [54.2, 17.1],
    [179.99, 0],
    [-179.99, -40],
    [0, 89.99],
    [10, -89.99],
  ]) {
    const radius = 30;
    const near = Array.from({ length: 50 }, (_, i) => ({
      id: `near${i}`,
      coords: destination(center, i * 1.2, i * 17).geometry.coordinates,
    }));
    const all = [...locations, ...near],
      query = workspaceSpatialIndex(all);
    assert.deepEqual(
      query(center, radius)
        .map((l) => l.id)
        .sort(),
      all
        .filter((l) => distance(center, l.coords) <= radius)
        .map((l) => l.id)
        .sort(),
    );
    assert.equal(all[0], locations[0], 'index must not mutate source objects');
  }
});

test('changing stop position/radius uses the new area without stale memberships', () => {
  const points = [
    { id: 'a', coords: [54, 17] },
    { id: 'b', coords: [54.01, 17] },
    { id: 'c', coords: [55, 18] },
  ];
  const query = workspaceSpatialIndex(points);
  assert.deepEqual(
    query([54, 17], 0.5).map((l) => l.id),
    ['a'],
  );
  assert.deepEqual(
    query([54, 17], 2).map((l) => l.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    query([55, 18], 0.5).map((l) => l.id),
    ['c'],
  );
});
