import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findTripByName,
  uniqueTripName,
  uniqueTripLabels,
  tripCloudId,
} from '../../src/utils/tripNames.js';
const trips = [
  { id: 'a', name: 'Kenya' },
  { id: 'b', name: 'Kenya 2' },
];
test('trip names match without differences in case or surrounding spaces', () => {
  assert.equal(findTripByName(trips, ' kenya ').id, 'a');
  assert.equal(findTripByName(trips, 'Peru'), undefined);
});
test('name suggestions keep existing trips and pick a free name', () => {
  assert.equal(uniqueTripName(trips, 'Kenya'), 'Kenya 3');
  assert.equal(uniqueTripName(trips, ' Peru '), 'Peru');
});

test('existing separate trips get unique labels without hiding or overwriting either copy', () => {
  const trips = [
    { id: 'a', name: 'Yucatan' },
    { id: 'b', name: ' yucatan ' },
    { id: 'c', name: 'Yucatan 2' },
  ];
  const labels = uniqueTripLabels(trips);
  assert.deepEqual(
    labels.map((trip) => trip.name),
    ['Yucatan', 'yucatan 3', 'Yucatan 2'],
  );
  assert.equal(trips[1].name, ' yucatan ');
  assert.deepEqual(
    labels.map((trip) => trip.id),
    ['a', 'b', 'c'],
  );
});

test('durable workspace cloud identity survives missing or outdated browser bindings', () => {
  assert.equal(tripCloudId({ id: 'local', sync: { cloudId: 'cloud' } }, {}), 'cloud');
  assert.equal(
    tripCloudId({ id: 'local', sync: { cloudId: 'cloud' } }, { local: { id: 'old' } }),
    'cloud',
  );
  assert.equal(tripCloudId({ id: 'local' }, { local: { id: 'legacy' } }), 'legacy');
});
