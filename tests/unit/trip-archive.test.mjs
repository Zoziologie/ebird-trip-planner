import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeTripArchive, decodeTripArchive } from '../../src/utils/tripArchive.js';

const payload = {
  version: 3,
  trip: {
    id: 'trip-one',
    name: 'Kenya 🐦',
    tripReportId: 'private-report',
    tripReportSyncedAt: 123,
  },
  ebd: {
    locations: [{ locality_id: 'L1' }],
    speciesList: [{ code: 'ostric2', liferWorld: true, liferRegion: false, tripReportSeen: true }],
  },
  visits: [
    {
      id: 1,
      tripId: 'trip-one',
      name: 'Visit',
      note: 'Gate opens at 7',
      targetSpecies: ['ostric2'],
    },
  ],
  lists: [{ tripId: 'trip-one', kind: 'world', species: ['ostric2'] }],
  checklists: Array.from({ length: 1000 }, () => ({
    tripId: 'trip-one',
    localityId: 'L1',
    checklist: [
      {
        checklist_id: 'S1',
        species: [{ code: 'ostric2', count: 'X', species_comment: 'Calling: "hello"' }],
      },
    ],
  })),
  comments: [{ checklist_id: 'S1', species_comments: [['ostric2', 'Calling: "hello"']] }],
};

test('compressed archive preserves the full trip including unicode, notes, counts and comments', async () => {
  const compressed = await encodeTripArchive(payload);
  assert.deepEqual(await decodeTripArchive(compressed), payload);
  assert.ok(compressed.size < JSON.stringify(payload).length / 5);
});

test('existing JSON exports and BOM-prefixed files remain readable', async () => {
  for (const prefix of ['', '\uFEFF']) {
    assert.deepEqual(
      await decodeTripArchive(new Blob([prefix + JSON.stringify(payload)])),
      payload,
    );
  }
});

test('unsupported future files and unrelated JSON do not import', async () => {
  await assert.rejects(
    decodeTripArchive(new Blob(['{"trip":{"id":"x"},"version":99}'])),
    /newer version/,
  );
  await assert.rejects(decodeTripArchive(new Blob(['{"hello":"world"}'])), /not an eBird/);
});

test('JSON and gzip import progress reaches the end of the file before parsing', async () => {
  for (const file of [new Blob([JSON.stringify(payload)]), await encodeTripArchive(payload)]) {
    const progress = [];
    assert.deepEqual(
      await decodeTripArchive(file, (fraction, stage) => progress.push({ fraction, stage })),
      payload,
    );
    const reading = progress.filter((item) => item.stage === 'reading');
    assert.equal(reading.at(-1).fraction, 1);
    assert.ok(
      reading.every(
        (item, index) => item.fraction >= (reading[index - 1]?.fraction || 0) && item.fraction <= 1,
      ),
    );
    assert.equal(progress.at(-1).stage, 'parsing');
  }
});
