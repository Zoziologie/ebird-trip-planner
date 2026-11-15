import test from 'node:test';
import assert from 'node:assert/strict';
import { tripDates, compareTripCards } from '../../src/utils/tripDates.js';

test('trip dates use the first and last dated stops and include both boundary days', () => {
  const stops = [
    { dateTime: '2026-02-20T09:00' },
    { dateTime: '' },
    { dateTime: '2026-02-16T07:00' },
  ];
  assert.deepEqual(tripDates(stops, 'UTC', new Date('2026-02-15T23:00:00Z')), {
    group: 'upcoming',
    start: '2026-02-16',
    end: '2026-02-20',
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
    start: '2026-02-16',
    end: '2026-02-16',
    label: '16 Feb 2026',
  });
  assert.equal(
    tripDates(stops, 'Europe/Paris', new Date('2026-02-15T21:00:00Z')).group,
    'upcoming',
  );
  assert.deepEqual(tripDates([], '', new Date()), { group: 'undated', label: 'No dates yet' });
});

test('trip cards keep their date order when an autosave changes recency', () => {
  const now = new Date('2026-11-15T00:00:00Z');
  const kenya = {
    name: 'Kenya',
    localId: 'kenya',
    updatedAt: 100,
    dates: tripDates([{ dateTime: '2026-12-10T07:00' }], 'UTC', now),
  };
  const yucatan = {
    name: 'Yucatan',
    cloudId: 'yucatan',
    updatedAt: 50,
    dates: tripDates([{ dateTime: '2026-11-21T07:00' }], 'UTC', now),
  };
  assert.deepEqual([kenya, yucatan].sort(compareTripCards), [yucatan, kenya]);
  yucatan.updatedAt = 150;
  assert.deepEqual([yucatan, kenya].sort(compareTripCards), [yucatan, kenya]);
});
