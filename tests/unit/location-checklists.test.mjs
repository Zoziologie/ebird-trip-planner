import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../../src/data/db.js';
import { readLocationChecklists } from '../../src/utils/tripData.js';

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
