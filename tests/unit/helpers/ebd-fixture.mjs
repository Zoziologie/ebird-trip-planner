// Builds small in-memory EBD files and runs them through the real import path.

import { readFile } from 'node:fs/promises';
import Papa from 'papaparse';
import {
  addEbdRow,
  beginEbdFile,
  createEbdImportAccumulator,
  finalizeEbdImport,
  EBD_PARSE_OPTIONS,
} from '../../../src/utils/ebdImport.js';

const taxonomy = JSON.parse(
  await readFile(new URL('../../../src/assets/eBird_taxonomy.json', import.meta.url)),
);
export const species = taxonomy.filter((t) => t.category === 'species' && t.sciName).slice(0, 2);
const byName = Object.fromEntries(taxonomy.filter((t) => t.sciName).map((t) => [t.sciName, t]));
const byCode = Object.fromEntries(
  taxonomy.filter((t) => t.speciesCode).map((t) => [t.speciesCode, t]),
);

export const COLUMNS = [
  'SCIENTIFIC NAME',
  'OBSERVATION COUNT',
  'COUNTRY',
  'COUNTRY CODE',
  'STATE',
  'STATE CODE',
  'COUNTY',
  'COUNTY CODE',
  'LOCALITY',
  'LOCALITY ID',
  'LOCALITY TYPE',
  'LATITUDE',
  'LONGITUDE',
  'OBSERVATION DATE',
  'TIME OBSERVATIONS STARTED',
  'SAMPLING EVENT IDENTIFIER',
  'DURATION MINUTES',
  'EFFORT DISTANCE KM',
  'ALL SPECIES REPORTED',
  'GROUP IDENTIFIER',
  'CHECKLIST COMMENTS',
  'SPECIES COMMENTS',
];

export const makeRow = (overrides = {}) => {
  const base = {
    'SCIENTIFIC NAME': species[0].sciName,
    'OBSERVATION COUNT': '2',
    COUNTRY: 'Mexico',
    'COUNTRY CODE': 'MX',
    STATE: 'Quintana Roo',
    'STATE CODE': 'MX-ROO',
    COUNTY: 'Cozumel',
    'COUNTY CODE': 'MX-ROO-001',
    LOCALITY: 'Test Marsh',
    'LOCALITY ID': 'L1',
    'LOCALITY TYPE': 'H',
    LATITUDE: '20.5',
    LONGITUDE: '-87.1',
    'OBSERVATION DATE': '2024-03-04',
    'TIME OBSERVATIONS STARTED': '07:30:00',
    'SAMPLING EVENT IDENTIFIER': 'S1',
    'DURATION MINUTES': '60',
    'EFFORT DISTANCE KM': '1.5',
    'ALL SPECIES REPORTED': '1',
    'GROUP IDENTIFIER': '',
    'CHECKLIST COMMENTS': '',
    'SPECIES COMMENTS': '',
    ...overrides,
  };
  return COLUMNS.map((name) => base[name] ?? '');
};

export const parse = (rows, header = COLUMNS) => {
  const text = [header, ...rows].map((row) => row.join('\t')).join('\n');
  const accumulator = createEbdImportAccumulator(byName, byCode);
  beginEbdFile(accumulator);
  // Papa writes defaults back into the config it is given, so it cannot take the
  // frozen shared object directly; every caller spreads it the same way.
  const parsed = Papa.parse(text, { ...EBD_PARSE_OPTIONS });
  for (const row of parsed.data) addEbdRow(row, accumulator);
  return finalizeEbdImport(accumulator);
};
