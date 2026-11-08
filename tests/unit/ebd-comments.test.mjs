// The comment corpus: what gets captured from an EBD, and how it is formatted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { COLUMNS, makeRow, parse, species } from './helpers/ebd-fixture.mjs';
import { buildCommentMarkdown } from '../../src/utils/commentExport.js';

test('checklist comments are read, under either column name', () => {
  const current = parse([makeRow({ 'CHECKLIST COMMENTS': 'Gate locked before 7am.' })]);
  assert.equal(current.checklists[0].checklist_comment, 'Gate locked before 7am.');

  const legacyColumns = COLUMNS.map((name) =>
    name === 'CHECKLIST COMMENTS' ? 'TRIP COMMENTS' : name,
  );
  const legacy = parse([makeRow({ 'CHECKLIST COMMENTS': 'Older export wording.' })], legacyColumns);
  assert.equal(legacy.checklists[0].checklist_comment, 'Older export wording.');
});

test('a comment repeated across merged rows is stored once', () => {
  const shared = { 'GROUP IDENTIFIER': 'G1', 'CHECKLIST COMMENTS': 'Shared trip note.' };
  const result = parse([
    makeRow({
      ...shared,
      'SAMPLING EVENT IDENTIFIER': 'S1',
      'SPECIES COMMENTS': 'One bird calling.',
    }),
    makeRow({
      ...shared,
      'SAMPLING EVENT IDENTIFIER': 'S2',
      'SPECIES COMMENTS': 'One bird calling.',
    }),
    makeRow({
      ...shared,
      'SAMPLING EVENT IDENTIFIER': 'S3',
      'SPECIES COMMENTS': 'Also seen perched.',
    }),
  ]);
  assert.equal(result.checklists.length, 1, 'a group identifier merges the rows');
  assert.equal(result.checklists[0].checklist_comment, 'Shared trip note.');
  assert.equal(
    result.checklists[0].species[0].species_comment,
    'One bird calling.; Also seen perched.',
  );
});

test('incomplete checklists keep their comments but not their species records', () => {
  const result = parse([
    makeRow({
      'SAMPLING EVENT IDENTIFIER': 'S9',
      'ALL SPECIES REPORTED': '0',
      'CHECKLIST COMMENTS': 'Quick roadside stop.',
      'SPECIES COMMENTS': 'Perched on wire.',
    }),
  ]);
  const checklist = result.checklists[0];
  assert.equal(checklist.all_species_reported, false);
  assert.deepEqual(checklist.species, [], 'species records are dropped for incomplete checklists');
  assert.equal(checklist.checklist_comment, 'Quick roadside stop.');
  assert.deepEqual(checklist.species_comments, [[species[0].speciesCode, 'Perched on wire.']]);
});

test('markdown groups by location and can narrow to one species', () => {
  const entries = [
    {
      checklist_id: 'S1',
      locality_id: 'L1',
      date: '2024-03-04',
      time: '07:30:00',
      duration_minutes: 60,
      checklist_comment: 'Gate locked before 7am.',
      species_comments: [
        ['aaa', 'Two adults.'],
        ['bbb', 'Heard only.'],
      ],
    },
    {
      checklist_id: 'S2',
      locality_id: 'L2',
      date: '2024-03-05',
      time: '06:00:00',
      duration_minutes: 45,
      checklist_comment: '',
      species_comments: [['bbb', 'Singing.']],
    },
  ];
  const locationsById = new Map([
    ['L1', { locality: 'Test Marsh', latitude: 20.5, longitude: -87.1 }],
    ['L2', { locality: 'Another Bay', latitude: 20.9, longitude: -87.4 }],
  ]);
  const speciesNameByCode = new Map([
    ['aaa', 'Great Egret'],
    ['bbb', 'Yucatan Jay'],
  ]);

  const all = buildCommentMarkdown({
    heading: 'Visit 1 - observer comments',
    entries,
    locationsById,
    speciesNameByCode,
  });
  assert.match(all, /2 locations · 2 checklists · 4 comments/);
  assert.ok(all.indexOf('## Another Bay') < all.indexOf('## Test Marsh'), 'locations sort by name');
  assert.match(all, /Checklist note: Gate locked before 7am\./);
  assert.match(all, /- Great Egret: Two adults\./);
  assert.match(all, /https:\/\/ebird\.org\/checklist\/S1/);

  const oneSpecies = buildCommentMarkdown({
    heading: 'Yucatan Jay - observer comments',
    entries,
    locationsById,
    speciesNameByCode,
    onlySpeciesCode: 'bbb',
  });
  assert.match(oneSpecies, /2 locations · 2 checklists · 2 comments/);
  assert.doesNotMatch(oneSpecies, /Great Egret/);
  assert.doesNotMatch(oneSpecies, /Checklist note/, 'a species export carries only that species');
});
