import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTripLibrary } from '../../src/utils/tripLibrary.js';
const cloud = (id, name, time, owned = true) => ({
  id,
  name,
  revision: 'v1',
  owned,
  updatedAt: { toMillis: () => time },
});
const binding = {
  id: 'cloud-a',
  revision: 'v1',
  savedAt: 200,
  savedLocalEdit: 100,
  savedVisitCount: 2,
};

test('linked browser and cloud trips appear once; separate trips with the same name remain separate', () => {
  const rows = buildTripLibrary(
    [
      { id: 'local-a', name: 'Kenya', updatedAt: 100 },
      { id: 'local-b', name: 'Kenya', updatedAt: 50 },
    ],
    [cloud('cloud-a', 'Kenya', 200), cloud('cloud-b', 'Kenya', 300, false)],
    { 'local-a': binding },
    {},
    { 'local-a': 2 },
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.key),
    ['cloud:cloud-b', 'browser:local-a', 'browser:local-b'],
  );
  assert.equal(rows[0].storage, 'Shared cloud trip');
  assert.equal(rows[1].status, 'Matches last cloud save');
  assert.equal(rows[2].storage, 'Browser only');
});

test('a deleted browser copy leaves the cloud trip available to open', () => {
  const rows = buildTripLibrary(
    [],
    [cloud('cloud-a', 'Kenya', 200)],
    { 'deleted-local': binding },
    {},
    {},
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].localId, '');
});

test('show newer cloud saves and unsaved browser changes, including deleted visits', () => {
  const local = [{ id: 'local-a', name: 'Kenya' }];
  assert.equal(
    buildTripLibrary(
      local,
      [cloud('cloud-a', 'Kenya', 200)],
      { 'local-a': binding },
      { 'local-a': 110 },
      { 'local-a': 2 },
    )[0].status,
    'Browser changes to save',
  );
  assert.equal(
    buildTripLibrary(
      local,
      [cloud('cloud-a', 'Kenya', 200)],
      { 'local-a': binding },
      { 'local-a': 100 },
      {},
    )[0].status,
    'Browser changes to save',
  );
  const newer = { ...cloud('cloud-a', 'Kenya', 250), revision: 'v2' };
  assert.equal(
    buildTripLibrary(
      local,
      [newer],
      { 'local-a': binding },
      { 'local-a': 110 },
      { 'local-a': 2 },
    )[0].status,
    'Newer version in cloud',
  );
});

test('signed-out and unavailable cloud trips retain their browser entry and last known save date', () => {
  const rows = buildTripLibrary(
    [{ id: 'local-a', name: 'Kenya' }],
    [],
    { 'local-a': binding },
    { 'local-a': 100 },
    { 'local-a': 2 },
  );
  assert.equal(rows[0].storage, 'Cloud linked');
  assert.equal(rows[0].cloudSavedAt, 200);
  assert.equal(rows[0].localId, 'local-a');
});
