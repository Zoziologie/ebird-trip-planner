import test from 'node:test';
import assert from 'node:assert/strict';
import { tripDates } from '../../src/utils/tripDates.js';

test('trip dates use the first and last dated stops and include both boundary days', () => {
  const stops = [
    { dateTime: '2026-02-20T09:00' },
    { dateTime: '' },
    { dateTime: '2026-02-16T07:00' },
  ];
  assert.deepEqual(tripDates(stops, 'UTC', new Date('2026-02-15T23:00:00Z')), {
    group: 'upcoming',
    label: '16 Feb 2026 – 20 Feb 2026',
  });
  assert.equal(tripDates(stops, 'UTC', new Date('2026-02-16T00:00:00Z')).group, 'current');
  assert.equal(tripDates(stops, 'UTC', new Date('2026-02-20T23:59:00Z')).group, 'current');
  assert.equal(tripDates(stops, 'UTC', new Date('2026-02-21T00:00:00Z')).group, 'past');
});

test('classification uses destination-local dates and handles undated trips', () => {
  const stops = [{ dateTime: '2026-02-16T07:00', latitude: 17, longitude: 54 }];
  assert.deepEqual(tripDates(stops, '', new Date('2026-02-15T21:00:00Z')), {
    group: 'current',
    label: '16 Feb 2026',
  });
  assert.equal(
    tripDates(stops, 'Europe/Paris', new Date('2026-02-15T21:00:00Z')).group,
    'upcoming',
  );
  assert.deepEqual(tripDates([], '', new Date()), { group: 'undated', label: 'No dates yet' });
});
