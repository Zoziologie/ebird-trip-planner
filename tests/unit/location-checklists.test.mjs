import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/data/db.js';
import { readLocationChecklists, readLocationDistances } from '../../src/utils/tripData.js';

const checklist = {
  checklist_id: 'S123',
  date: '2026-11-15',
  time: '06:30',
  species: [{ code: 'osprey' }],
};

test('location checklist links read one stored location without loading the full dataset', async (t) => {
  t.mock.method(db.checklists, 'get', async (key) => {
    assert.deepEqual(key, ['trip', 'L1']);
    return { checklist: [checklist] };
  });
  t.mock.method(db.ebd, 'get', () => assert.fail('The full dataset should not be read'));
  assert.deepEqual(await readLocationChecklists('trip', 'L1'), [
    { id: 'S123', date: '2026-11-15', time: '06:30' },
  ]);
});

test('location checklist links also support embedded checklists in older archives', async (t) => {
  t.mock.method(db.checklists, 'get', async () => undefined);
  t.mock.method(db.ebd, 'get', async () => ({
    locations: [{ locality_id: 123, checklist: [checklist] }],
  }));
  assert.equal((await readLocationChecklists('trip', '123'))[0].id, 'S123');
  assert.deepEqual(await readLocationChecklists('trip', 'elsewhere'), []);
});

test('legacy distance summaries use recorded positive distances from complete lists', async (t) => {
  t.mock.method(db.checklists, 'bulkGet', async (keys) => {
    assert.deepEqual(keys, [
      ['trip', 'L1'],
      ['trip', 'L2'],
    ]);
    return [
      {
        checklist: [
          { effort_distance_km: '1.5', all_species_reported: true },
          { effort_distance_km: 3 },
          { effort_distance_km: 0 },
          { effort_distance_km: null },
          { effort_distance_km: '' },
          { effort_distance_km: 'X' },
          { effort_distance_km: 25, all_species_reported: false },
        ],
      },
      undefined,
    ];
  });
  assert.deepEqual(await readLocationDistances('trip', ['L1', 'L2']), { L1: [1.5, 3], L2: [] });
});
