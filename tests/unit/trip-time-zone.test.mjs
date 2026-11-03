import test from 'node:test';
import assert from 'node:assert/strict';
import { tripTimeZone } from '../../src/utils/tripTimeZone.js';
import { buildWorkspacePlan, workspaceVisits } from '../../src/utils/workspacePlan.js';

test('automatic trip clocks use destination coordinates rather than the planning device', () => {
  assert.equal(tripTimeZone('', 17, 54), 'Asia/Muscat');
  assert.equal(tripTimeZone('', 48.85, 2.35), 'Europe/Paris');
  assert.equal(tripTimeZone('', 40.71, -74), 'America/New_York');
  assert.equal(tripTimeZone('Asia/Muscat', 48.85, 2.35), 'Asia/Muscat');
  assert.equal(tripTimeZone(''), 'UTC');
});

test('destination clocks account for daylight saving and local date boundaries', () => {
  const paris = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tripTimeZone('', 48.85, 2.35),
    dateStyle: 'short',
    timeStyle: 'short',
  });
  assert.equal(paris.format(new Date('2026-01-01T23:30:00Z')), '2026-01-02 00:30');
  assert.equal(paris.format(new Date('2026-07-01T23:30:00Z')), '2026-07-02 01:30');
});

test('automatic mode and explicit overrides round-trip without converting local stop times', () => {
  const visits = [
    { workspaceId: 'stop', dateTime: '2026-02-16T07:00', latitude: 17, longitude: 54 },
  ];
  for (const timeZone of ['', 'Asia/Muscat', 'Europe/Paris']) {
    const plan = buildWorkspacePlan({ name: 'Oman', timeZone }, visits);
    const restored = workspaceVisits(plan, 'imported');
    assert.equal(plan.timeZone, timeZone);
    assert.equal(restored[0].dateTime, visits[0].dateTime);
    assert.equal(
      tripTimeZone(plan.timeZone, restored[0].latitude, restored[0].longitude),
      timeZone || 'Asia/Muscat',
    );
  }
});
