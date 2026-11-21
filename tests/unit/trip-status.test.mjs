import test from 'node:test';
import assert from 'node:assert/strict';
import { tripCardStatus, stopsWithMap, offlineReadiness } from '../../src/utils/tripStatus.js';

const ids = (chips) => chips.map((chip) => chip.id);
const linked = { localId: 't1', sync: { cloudId: 'c1' }, cloudId: 'c1', cloud: { owned: true } };

test('a cloud trip not downloaded says so and nothing about backup', () => {
  assert.deepEqual(ids(tripCardStatus({ localId: '', cloudId: 'c1', cloud: { owned: true } })), [
    'cloud-only',
  ]);
});

test('a device trip without cloud autosave is not backed up, legacy cloud copy or not', () => {
  const plain = tripCardStatus({ localId: 't1', sync: { cloudId: '' } });
  assert.deepEqual(ids(plain), ['on-device', 'device-only']);
  const legacy = tripCardStatus({ localId: 't1', sync: { cloudId: '' }, cloudId: 'old' });
  assert.equal(legacy[1].id, 'device-only');
  assert.match(legacy[1].title, /older cloud copy/);
});

test('backup chip follows the sync coordinator state', () => {
  for (const [state, id] of [
    ['synced', 'synced'],
    ['pending', 'pending'],
    ['syncing', 'syncing'],
    ['sign-in', 'sign-in'],
    ['error', 'error'],
    [undefined, 'cloud'],
  ])
    assert.equal(tripCardStatus(linked, state)[1].id, id, String(state));
  assert.equal(tripCardStatus(linked, 'error', 'Quota exceeded')[1].title, 'Quota exceeded');
});

test('trips owned by someone else are tagged as shared', () => {
  const chips = tripCardStatus({ ...linked, cloud: { owned: false } }, 'synced');
  assert.deepEqual(ids(chips), ['on-device', 'synced', 'shared']);
  assert.deepEqual(ids(tripCardStatus({ localId: '', cloud: { owned: false } })), [
    'cloud-only',
    'shared',
  ]);
});

test('a stop has a map when a detailed tile under it is cached, in any tileset', () => {
  const sempach = { longitude: 8.19, latitude: 47.14 };
  const zurich = { longitude: 8.54, latitude: 47.37 };
  // Tile 12/2141/1438 holds Sempach; zoom 10 is too coarse to count.
  const cached = new Set(['mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2/12/2141/1438']);
  assert.deepEqual(stopsWithMap([sempach, zurich], cached), [sempach]);
  assert.deepEqual(stopsWithMap([sempach], new Set(['mapbox.satellite/10/535/358'])), []);
});

test('readiness lists what to do before leaving', () => {
  const item = { ...linked, visits: [{}, {}, {}] };
  const checks = offlineReadiness(item, 'pending', { mapStops: 1, installed: false, ios: true });
  const todo = checks.filter((check) => check.state === 'todo').map((check) => check.title);
  assert.deepEqual(todo, [
    'Changes not uploaded yet',
    'Detailed map saved around 1 of 3 stops',
    'Not installed as an app',
  ]);
  assert.match(checks.find((c) => c.title === 'Not installed as an app').detail, /Home Screen/);
  const cloudOnly = offlineReadiness({ localId: '', cloudId: 'c1' }, undefined, {});
  assert.equal(cloudOnly[0].action, 'download');
});
