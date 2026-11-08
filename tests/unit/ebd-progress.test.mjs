import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { COLUMNS, makeRow, parse, species } from './helpers/ebd-fixture.mjs';
import {
  createEbdImportAccumulator,
  finalizeEbdImport,
  streamEbdTextFile,
  streamEbdZipEntry,
} from '../../src/utils/ebdImport.js';
const rows = Array.from({ length: 6500 }, (_, index) =>
  makeRow({
    'SAMPLING EVENT IDENTIFIER': `S${index}`,
    LOCALITY: 'München 🐦',
    'SPECIES COMMENTS': 'é 🐦 '.repeat(10),
  }),
);
const text = [COLUMNS, ...rows].map((row) => row.join('\t')).join('\n');
const accumulator = () =>
  createEbdImportAccumulator(
    Object.fromEntries(species.map((taxon) => [taxon.sciName, taxon])),
    Object.fromEntries(species.map((taxon) => [taxon.speciesCode, taxon])),
  );
test('UTF-8 text reads preserve data across byte chunks and report monotonic byte progress', async () => {
  const data = accumulator();
  const progress = [];
  await streamEbdTextFile(new Blob([text]), data, (value) => progress.push(value));
  assert.deepEqual(finalizeEbdImport(data), parse(rows));
  assert.ok(progress.length > 1);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((value, index) => value >= (progress[index - 1] || 0) && value <= 1));
});
test('ZIP progress counts parsed decompressed bytes and preserves UTF-8 comments', async () => {
  const archive = new JSZip();
  archive.file('ebd.txt', new TextEncoder().encode(text));
  const zip = await JSZip.loadAsync(
    await archive.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
  );
  const data = accumulator();
  const progress = [];
  await streamEbdZipEntry(zip.file('ebd.txt'), data, (value) => progress.push(value));
  assert.deepEqual(finalizeEbdImport(data), parse(rows));
  assert.equal(progress.at(-1), 100);
  assert.ok(progress.every((value, index) => value >= (progress[index - 1] || 0) && value <= 100));
});
