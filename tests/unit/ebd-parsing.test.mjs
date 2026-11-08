// The EBD is an unquoted TSV. A parser that applies CSV quoting rules to it
// silently swallows rows: on a real state export, 7.1% of observations vanished
// into 58 comments that happened to open with a double quote.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRow, parse } from './helpers/ebd-fixture.mjs';

test('a comment opening with a double quote does not swallow later rows', () => {
  const result = parse([
    makeRow({
      'SAMPLING EVENT IDENTIFIER': 'S1',
      'SPECIES COMMENTS': '"Slewing" in erratic soaring flight.',
    }),
    makeRow({ 'SAMPLING EVENT IDENTIFIER': 'S2' }),
    makeRow({ 'SAMPLING EVENT IDENTIFIER': 'S3' }),
  ]);
  assert.equal(result.recordCount, 3, 'every row must be counted');
  assert.equal(result.checklists.length, 3);
  const quoted = result.checklists.find((c) => c.checklist_id === 'S1');
  assert.equal(quoted.species[0].species_comment, '"Slewing" in erratic soaring flight.');
});

test('a tab-free quoted value stays one field', () => {
  const result = parse([
    makeRow({ LOCALITY: 'Mirador "El Cielo"', 'SAMPLING EVENT IDENTIFIER': 'S1' }),
  ]);
  assert.equal(result.recordCount, 1);
  assert.equal(result.checklists[0].location.locality, 'Mirador "El Cielo"');
});
