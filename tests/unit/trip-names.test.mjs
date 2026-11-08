import test from 'node:test';
import assert from 'node:assert/strict';
import { findTripByName, uniqueTripName } from '../../src/utils/tripNames.js';
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
