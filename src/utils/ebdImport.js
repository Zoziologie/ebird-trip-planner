import Papa from 'papaparse';

// Columns we read out of an EBD export. Rows are parsed as plain arrays
// (`header: false`) and resolved through this index map: building one 48-key
// object per row is by far the dominant cost when importing millions of rows.
const EBD_COLUMNS = {
  count: 'OBSERVATION COUNT',
  county: 'COUNTY',
  countyCode: 'COUNTY CODE',
  state: 'STATE',
  stateCode: 'STATE CODE',
  country: 'COUNTRY',
  countryCode: 'COUNTRY CODE',
  date: 'OBSERVATION DATE',
  time: 'TIME OBSERVATIONS STARTED',
  scientificName: 'SCIENTIFIC NAME',
  checklistId: 'SAMPLING EVENT IDENTIFIER',
  groupId: 'GROUP IDENTIFIER',
  allSpeciesReported: 'ALL SPECIES REPORTED',
  localityId: 'LOCALITY ID',
  locality: 'LOCALITY',
  localityType: 'LOCALITY TYPE',
  latitude: 'LATITUDE',
  longitude: 'LONGITUDE',
  durationMinutes: 'DURATION MINUTES',
  effortDistanceKm: 'EFFORT DISTANCE KM',
  speciesComments: 'SPECIES COMMENTS',
  // eBird renamed this column; exports older than 2024 call it "TRIP COMMENTS".
  checklistComments: ['CHECKLIST COMMENTS', 'TRIP COMMENTS'],
};

const EBD_COLUMN_FIELDS = Object.keys(EBD_COLUMNS);

// A header row is required to locate columns; without "SCIENTIFIC NAME" and
// "SAMPLING EVENT IDENTIFIER" we cannot make sense of the file at all.
const buildColumnIndex = (headerRow) => {
  const positions = new Map();
  for (let i = 0; i < headerRow.length; i += 1) {
    const name = typeof headerRow[i] === 'string' ? headerRow[i].trim().toUpperCase() : '';
    if (name && !positions.has(name)) positions.set(name, i);
  }
  const columns = {};
  for (const field of EBD_COLUMN_FIELDS) {
    const names = EBD_COLUMNS[field];
    let index;
    if (Array.isArray(names)) {
      for (const name of names) {
        index = positions.get(name);
        if (index !== undefined) break;
      }
    } else {
      index = positions.get(names);
    }
    columns[field] = index === undefined ? -1 : index;
  }
  if (columns.scientificName < 0 || columns.checklistId < 0) return null;
  return columns;
};

const cell = (row, index) => (index < 0 ? undefined : row[index]);

// Group checklists and subspecies rollups fold several rows into one record, so
// a comment can arrive more than once for the same target. Append only what is
// genuinely new.
const mergeComment = (existing, incoming) => {
  if (!incoming || incoming === existing) return existing;
  if (!existing) return incoming;
  return `${existing}; ${incoming}`;
};

// "2019-04-21" -> 2019, without allocating a substring per row.
const parseYear = (date) => {
  if (typeof date !== 'string' || date.length < 4) return NaN;
  let year = 0;
  for (let i = 0; i < 4; i += 1) {
    const digit = date.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return NaN;
    year = year * 10 + digit;
  }
  return year;
};

export const createEbdImportAccumulator = (taxonomyByScientificName, taxonomyByCode) => ({
  taxonomyByScientificName,
  taxonomyByCode,
  columns: null,
  checklists: new Map(),
  locations: new Map(),
  counties: new Map(),
  states: new Map(),
  minYear: Infinity,
  maxYear: -Infinity,
  recordCount: 0,
});

// Each EBD file carries its own header row, so column positions must be
// re-learned whenever a new file starts feeding the shared accumulator.
export const beginEbdFile = (accumulator) => {
  accumulator.columns = null;
};

export const addEbdRow = (row, accumulator) => {
  let columns = accumulator.columns;
  if (!columns) {
    columns = buildColumnIndex(row);
    if (!columns) return;
    accumulator.columns = columns;
    return;
  }

  const count = cell(row, columns.count);
  if (count === '0') return;

  accumulator.recordCount++;

  const countyCode = cell(row, columns.countyCode);
  const stateCode = cell(row, columns.stateCode);
  if (countyCode && !accumulator.counties.has(countyCode)) {
    accumulator.counties.set(countyCode, { name: cell(row, columns.county), code: countyCode });
  }
  if (stateCode && !accumulator.states.has(stateCode)) {
    accumulator.states.set(stateCode, { name: cell(row, columns.state), code: stateCode });
  }

  const date = cell(row, columns.date);
  const year = parseYear(date);
  if (year < accumulator.minYear) accumulator.minYear = year;
  if (year > accumulator.maxYear) accumulator.maxYear = year;

  const sciName = cell(row, columns.scientificName);
  const match = accumulator.taxonomyByScientificName[sciName];
  const speciesID = match?.reportAs || match?.REPORT_AS || match?.speciesCode || sciName;
  const taxon = accumulator.taxonomyByCode[speciesID];
  if (taxon?.category !== 'species') return;

  const checklistId = cell(row, columns.checklistId);
  const groupId = cell(row, columns.groupId) || checklistId;
  const isComplete = cell(row, columns.allSpeciesReported) === '1';
  let checklist = accumulator.checklists.get(groupId);

  if (!checklist) {
    const localityId = cell(row, columns.localityId);
    let location = accumulator.locations.get(localityId);
    if (!location) {
      location = {
        latitude: Number(cell(row, columns.latitude)),
        longitude: Number(cell(row, columns.longitude)),
        locality: cell(row, columns.locality),
        locality_id: localityId,
        locality_hotspot: cell(row, columns.localityType) === 'H',
        country: cell(row, columns.country),
        country_code: cell(row, columns.countryCode),
        state: cell(row, columns.state),
        state_code: stateCode,
        county: cell(row, columns.county),
        county_code: countyCode,
      };
      accumulator.locations.set(localityId, location);
    }

    checklist = {
      checklist_id: checklistId,
      date,
      time: cell(row, columns.time),
      location,
      duration_minutes: Number(cell(row, columns.durationMinutes)),
      effort_distance_km: Number(cell(row, columns.effortDistanceKm)),
      all_species_reported: isComplete,
      speciesByCode: isComplete ? new Map() : null,
      checklist_comment: cell(row, columns.checklistComments) || '',
      // Comment-bearing species only, kept for every checklist including the
      // incomplete ones whose species records are otherwise discarded. This is
      // the source for the comment corpus; allocated lazily because ~90% of
      // checklists carry no comment at all.
      commentsByCode: null,
    };
    accumulator.checklists.set(groupId, checklist);
  } else {
    checklist.all_species_reported = checklist.all_species_reported && isComplete;
    if (!checklist.all_species_reported) checklist.speciesByCode = null;
    checklist.checklist_comment = mergeComment(
      checklist.checklist_comment,
      cell(row, columns.checklistComments),
    );
  }

  const rowComment = cell(row, columns.speciesComments);
  if (rowComment) {
    if (!checklist.commentsByCode) checklist.commentsByCode = new Map();
    checklist.commentsByCode.set(
      taxon.speciesCode,
      mergeComment(checklist.commentsByCode.get(taxon.speciesCode), rowComment),
    );
  }

  if (!checklist.speciesByCode) return;

  const speciesCode = taxon.speciesCode;
  const existing = checklist.speciesByCode.get(speciesCode);
  if (!existing) {
    checklist.speciesByCode.set(speciesCode, {
      code: speciesCode,
      count,
      species_comment: rowComment || '',
    });
    return;
  }

  const existingNum = Number(existing.count);
  const incomingNum = Number(count);
  if (Number.isFinite(existingNum) && Number.isFinite(incomingNum) && incomingNum > existingNum) {
    existing.count = count;
  } else if (!existing.count && count) {
    existing.count = count;
  }
  existing.species_comment = mergeComment(existing.species_comment, rowComment);
};

export const finalizeEbdImport = (accumulator) => {
  for (const checklist of accumulator.checklists.values()) {
    checklist.species = checklist.speciesByCode ? Array.from(checklist.speciesByCode.values()) : [];
    delete checklist.speciesByCode;
    checklist.species_comments = checklist.commentsByCode
      ? Array.from(checklist.commentsByCode.entries())
      : [];
    delete checklist.commentsByCode;
  }

  return {
    checklists: Array.from(accumulator.checklists.values()),
    counties: Array.from(accumulator.counties.values()),
    states: Array.from(accumulator.states.values()),
    minYear: accumulator.minYear,
    maxYear: accumulator.maxYear,
    recordCount: accumulator.recordCount,
  };
};

// The EBD is a plain unquoted TSV: eBird strips tabs and newlines out of text
// fields, so every row splits cleanly on tabs and a `"` inside a comment is
// literal data. Papa's default quote handling reads a leading `"` as opening a
// quoted field and then swallows everything up to the next one - which drops
// whole spans of the file (7.1% of rows on a real state export) and stores the
// swallowed text as a multi-megabyte "comment". Disabling the quote characters
// is what makes the parse faithful.
export const EBD_PARSE_OPTIONS = Object.freeze({
  header: false,
  delimiter: '\t',
  quoteChar: '\u0000',
  escapeChar: '\u0000',
  skipEmptyLines: true,
  dynamicTyping: false,
});

export const streamEbdZipEntry = (entry, accumulator, onProgress) =>
  new Promise((resolve, reject) => {
    beginEbdFile(accumulator);
    const parser = new Papa.StringStreamer({
      ...EBD_PARSE_OPTIONS,
      chunk(results) {
        for (const row of results.data) addEbdRow(row, accumulator);
      },
      complete: resolve,
      error: reject,
    });
    parser._nextChunk = () => {};

    const decoder = new TextDecoder();
    let bytesRead = 0;
    entry
      .internalStream('uint8array')
      .on('data', (chunk) => {
        parser._finished = false;
        parser.parseChunk(decoder.decode(chunk, { stream: true }));
        bytesRead += chunk.byteLength;
        onProgress?.((bytesRead / entry._data.uncompressedSize) * 100, accumulator.recordCount);
      })
      .on('error', reject)
      .on('end', () => {
        parser._finished = true;
        parser.parseChunk(decoder.decode());
      })
      .resume();
  });

// Read byte-sized chunks so UTF-8 names and comments do not distort the progress.
export const streamEbdTextFile = async (file, accumulator, onProgress) => {
  beginEbdFile(accumulator);
  const parser = new Papa.StringStreamer({
    ...EBD_PARSE_OPTIONS,
    chunk(results) {
      for (const row of results.data) addEbdRow(row, accumulator);
    },
  });
  parser._nextChunk = () => {};
  const decoder = new TextDecoder();
  for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
    const end = Math.min(offset + 1024 * 1024, file.size);
    parser._finished = false;
    parser.parseChunk(
      decoder.decode(await file.slice(offset, end).arrayBuffer(), { stream: true }),
    );
    onProgress(end / file.size);
  }
  parser._finished = true;
  parser.parseChunk(decoder.decode());
};
