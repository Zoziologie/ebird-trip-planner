// Generate a synthetic EBD export sized like a real one.
//
// Shape parameters are calibrated against ebd_MX-ROO_relJul-2026 (see
// tests/perf/README.md). Scale 1 reproduces roughly that export; the documented
// high end for a single trip is scale 2-4.
//
// Known simplification: 46.7% of real EBD rows belong to shared group checklists,
// and subspecies roll up into their parent species, so a real checklist averages
// 19.4 rows against the 16.7 species it records. This generator emits exactly one
// row per species, so it produces ~19% fewer rows than a real export with the same
// checklist count, and never exercises the group-merge path in addEbdRow.
//
//   node tests/perf/make-ebd-fixture.mjs --scale 2 --out /tmp/ebd-2x.txt
//   node tests/perf/make-ebd-fixture.mjs --scale 0.02 --out /tmp/ebd-dev.txt
//
// Writes a tab-separated .txt with the real EBD column set. Zip it if you want
// to exercise the archive path the app actually uses:
//   zip -j -q /tmp/ebd-2x.zip /tmp/ebd-2x.txt

import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

// --- Calibration: measured on ebd_MX-ROO_relJul-2026 (2,764,777 records) ------
const REFERENCE = {
  locations: 33370,
  checklists: 142206,
  completeFraction: 0.74,
  distinctSpecies: 506,
  // Species per complete checklist: lognormal, median 12, mean 16.6, p90 36.
  speciesPerChecklist: { mu: Math.log(12), sigma: 0.805, max: 171 },
  // Checklists per location: lognormal, median 1, mean 4.3, long tail.
  checklistsPerLocation: { mu: 0, sigma: 1.709, max: 1669 },
  durationMinutes: { mu: Math.log(56), sigma: 1.1 },
  // 3.51% of observations carry a species comment: median 17 chars, mean 36,
  // p90 84, max 2735. Comments are ~2% of the stored trip, not the third an
  // earlier calibration assumed - that figure came from a parser bug that
  // vacuumed file content into any comment starting with a quote.
  commentRate: 0.0351,
  commentLength: { mu: Math.log(17), sigma: 1.229, max: 2735 },
  // 10.5% of checklists carry a checklist-level comment: median 50, mean 85.
  checklistCommentRate: 0.1047,
  checklistCommentLength: { mu: Math.log(50), sigma: 1.035, max: 3495 },
  // Deliberately above the real 0.0006 so even a scale-0.02 dev fixture contains
  // comments that open with a double quote. Those are what exposed the parser
  // dropping 7.1% of rows; at the true rate a small fixture would contain none.
  leadingQuoteRate: 0.01,
  // Hotspots are 1.5% of localities but hold most of the checklists, so they are
  // assigned to the busiest locations rather than drawn independently.
  hotspotFraction: 0.015,
  years: [1990, 2026],
  // Bounding box of the reference region, kept small so clustering behaves like
  // a real state-level export rather than points scattered over a continent.
  bbox: { minLon: -89.3, maxLon: -86.7, minLat: 17.8, maxLat: 21.6 },
};

// Exactly the relJul-2026 header: 52 named columns plus the trailing tab eBird
// writes, which makes every row 53 fields. Column names matter - the importer
// resolves fields by name, and "CHECKLIST COMMENTS" was "TRIP COMMENTS" here.
const EBD_COLUMNS = [
  'GLOBAL UNIQUE IDENTIFIER',
  'LAST EDITED DATE',
  'TAXONOMIC ORDER',
  'CATEGORY',
  'TAXON CONCEPT ID',
  'COMMON NAME',
  'SCIENTIFIC NAME',
  'SUBSPECIES COMMON NAME',
  'SUBSPECIES SCIENTIFIC NAME',
  'EXOTIC CODE',
  'OBSERVATION COUNT',
  'BREEDING CODE',
  'BREEDING CATEGORY',
  'BEHAVIOR CODE',
  'AGE/SEX',
  'COUNTRY',
  'COUNTRY CODE',
  'STATE',
  'STATE CODE',
  'COUNTY',
  'COUNTY CODE',
  'IBA CODE',
  'BCR CODE',
  'USFWS CODE',
  'ATLAS BLOCK',
  'LOCALITY',
  'LOCALITY ID',
  'LOCALITY TYPE',
  'LATITUDE',
  'LONGITUDE',
  'OBSERVATION DATE',
  'TIME OBSERVATIONS STARTED',
  'OBSERVER ID',
  'OBSERVER ORCID ID',
  'SAMPLING EVENT IDENTIFIER',
  'OBSERVATION TYPE',
  'PROTOCOL NAME',
  'PROTOCOL CODE',
  'PROJECT NAMES',
  'PROJECT IDENTIFIERS',
  'DURATION MINUTES',
  'EFFORT DISTANCE KM',
  'EFFORT AREA HA',
  'NUMBER OBSERVERS',
  'ALL SPECIES REPORTED',
  'GROUP IDENTIFIER',
  'HAS MEDIA',
  'APPROVED',
  'REVIEWED',
  'REASON',
  'CHECKLIST COMMENTS',
  'SPECIES COMMENTS',
  '',
];
const COL = Object.fromEntries(EBD_COLUMNS.map((name, index) => [name, index]));

const parseArgs = () => {
  const args = { scale: 1, out: '', seed: 42 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'scale') args.scale = Number(argv[++i]);
    else if (key === 'out') args.out = argv[++i];
    else if (key === 'seed') args.seed = Number(argv[++i]);
  }
  if (!args.out || !Number.isFinite(args.scale) || args.scale <= 0) {
    console.error(
      'Usage: node tests/perf/make-ebd-fixture.mjs --scale <n> --out <file.txt> [--seed <n>]',
    );
    process.exit(1);
  }
  return args;
};

// mulberry32 - small deterministic PRNG so fixtures are reproducible.
const makeRandom = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const makeLognormal =
  (random, { mu, sigma, max = Infinity }) =>
  () => {
    // Box-Muller; one normal per draw is plenty here.
    const u1 = Math.max(random(), 1e-12);
    const u2 = random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.min(max, Math.max(1, Math.round(Math.exp(mu + sigma * z))));
  };

const run = async () => {
  const { scale, out, seed } = parseArgs();
  const random = makeRandom(seed);

  const taxonomy = JSON.parse(
    await readFile(new URL('../../src/assets/eBird_taxonomy.json', import.meta.url)),
  );
  const pool = taxonomy.filter((t) => t.category === 'species');
  const speciesPool = [];
  for (let i = 0; i < REFERENCE.distinctSpecies && i < pool.length; i += 1) {
    speciesPool.push(pool[Math.floor((i / REFERENCE.distinctSpecies) * pool.length)]);
  }
  // Zipf weights reproduce the real "top 10 species are ~22% of observations".
  const weights = speciesPool.map((_, i) => 1 / Math.pow(i + 1, 0.75));
  const cumulative = [];
  let acc = 0;
  for (const w of weights) cumulative.push((acc += w));
  const pickSpecies = () => {
    const target = random() * acc;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return speciesPool[lo];
  };

  const targetLocations = Math.max(1, Math.round(REFERENCE.locations * scale));
  const targetChecklists = Math.max(1, Math.round(REFERENCE.checklists * scale));
  const drawSpeciesCount = makeLognormal(random, REFERENCE.speciesPerChecklist);
  const drawChecklistCount = makeLognormal(random, REFERENCE.checklistsPerLocation);
  const drawDuration = makeLognormal(random, REFERENCE.durationMinutes);
  const drawCommentLength = makeLognormal(random, REFERENCE.commentLength);
  const drawChecklistCommentLength = makeLognormal(random, REFERENCE.checklistCommentLength);
  const COMMENT_SOURCE =
    'Seen well in the canopy, photographed; heard calling repeatedly nearby; ' +
    'compared against reference recordings and confirmed by a second observer. ';
  const CHECKLIST_COMMENT_SOURCE =
    'Morning walk along the entrance track, light wind and broken cloud; ' +
    'access is through the gate by the km 12 marker, park on the verge. ';
  const makeText = (source, length) => {
    let text = '';
    while (text.length < length) text += source;
    text = text.slice(0, length);
    // A real comment often opens with a quoted word. The importer must treat it
    // as literal text rather than as the start of a quoted CSV field.
    return random() < REFERENCE.leadingQuoteRate ? `"${text.slice(1)}` : text;
  };
  const makeComment = () => makeText(COMMENT_SOURCE, drawCommentLength());
  const makeChecklistComment = () =>
    makeText(CHECKLIST_COMMENT_SOURCE, drawChecklistCommentLength());

  const { bbox } = REFERENCE;
  const counties = Array.from({ length: 12 }, (_, i) => ({
    name: `County ${i + 1}`,
    code: `MX-ROO-${String(i + 1).padStart(3, '0')}`,
  }));

  const locations = [];
  let plannedChecklists = 0;
  for (let i = 0; i < targetLocations; i += 1) {
    const count = drawChecklistCount();
    const county = counties[Math.floor(random() * counties.length)];
    locations.push({
      id: `L${1000000 + i}`,
      name: `Locality ${i}`,
      lat: bbox.minLat + random() * (bbox.maxLat - bbox.minLat),
      lon: bbox.minLon + random() * (bbox.maxLon - bbox.minLon),
      hotspot: false,
      county,
      count,
    });
    plannedChecklists += count;
  }
  // Hotspots are the busiest localities, not a random 1.5% of them: that is what
  // makes them carry roughly half the observations, as they do in a real export.
  const byBusiest = [...locations].sort((a, b) => b.count - a.count);
  const hotspotCount = Math.max(1, Math.round(locations.length * REFERENCE.hotspotFraction));
  for (let i = 0; i < hotspotCount; i += 1) byBusiest[i].hotspot = true;
  // Rescale so the total lands on the requested checklist count.
  const adjust = targetChecklists / plannedChecklists;
  let totalChecklists = 0;
  for (const location of locations) {
    location.count = Math.max(1, Math.round(location.count * adjust));
    totalChecklists += location.count;
  }

  const stream = createWriteStream(out, { encoding: 'utf8', highWaterMark: 1 << 22 });
  const write = async (chunk) => {
    if (!stream.write(chunk)) await once(stream, 'drain');
  };
  await write(`${EBD_COLUMNS.join('\t')}\n`);

  const [minYear, maxYear] = REFERENCE.years;
  let checklistIndex = 0;
  let records = 0;
  let buffer = '';
  const row = new Array(EBD_COLUMNS.length).fill('');

  for (const location of locations) {
    for (let c = 0; c < location.count; c += 1) {
      const sampleId = `S${10000000 + checklistIndex++}`;
      const complete = random() < REFERENCE.completeFraction;
      const year = minYear + Math.floor(random() * (maxYear - minYear + 1));
      const month = 1 + Math.floor(random() * 12);
      const day = 1 + Math.floor(random() * 28);
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const time = `${String(5 + Math.floor(random() * 14)).padStart(2, '0')}:${String(Math.floor(random() * 60)).padStart(2, '0')}:00`;
      const duration = drawDuration();
      // Repeated on every row of the checklist, exactly as eBird exports it.
      const checklistComment =
        random() < REFERENCE.checklistCommentRate ? makeChecklistComment() : '';

      // Sample without replacement so a checklist never repeats a species.
      const wanted = drawSpeciesCount();
      const chosen = new Map();
      for (let attempt = 0; attempt < wanted * 3 && chosen.size < wanted; attempt += 1) {
        const taxon = pickSpecies();
        if (!chosen.has(taxon.speciesCode)) chosen.set(taxon.speciesCode, taxon);
      }

      for (const taxon of chosen.values()) {
        row.fill('');
        row[COL['GLOBAL UNIQUE IDENTIFIER']] = `URN:CornellLabOfOrnithology:EBIRD:OBS${records}`;
        row[COL['LAST EDITED DATE']] = `${date} 12:00:00`;
        row[COL['TAXONOMIC ORDER']] = String(taxon.taxonOrder ?? 0);
        row[COL.CATEGORY] = 'species';
        row[COL['TAXON CONCEPT ID']] = `avibase-${taxon.speciesCode}`;
        row[COL['COMMON NAME']] = taxon.comName || '';
        row[COL['SCIENTIFIC NAME']] = taxon.sciName || '';
        row[COL['OBSERVATION COUNT']] =
          random() < 0.12 ? 'X' : String(1 + Math.floor(random() * 20));
        row[COL.COUNTRY] = 'Mexico';
        row[COL['COUNTRY CODE']] = 'MX';
        row[COL.STATE] = 'Quintana Roo';
        row[COL['STATE CODE']] = 'MX-ROO';
        row[COL.COUNTY] = location.county.name;
        row[COL['COUNTY CODE']] = location.county.code;
        row[COL['BCR CODE']] = '56';
        row[COL.LOCALITY] = location.name;
        row[COL['LOCALITY ID']] = location.id;
        row[COL['LOCALITY TYPE']] = location.hotspot ? 'H' : 'P';
        row[COL.LATITUDE] = location.lat.toFixed(7);
        row[COL.LONGITUDE] = location.lon.toFixed(7);
        row[COL['OBSERVATION DATE']] = date;
        row[COL['TIME OBSERVATIONS STARTED']] = time;
        row[COL['OBSERVER ID']] = `obsr${100000 + Math.floor(random() * 20000)}`;
        row[COL['SAMPLING EVENT IDENTIFIER']] = sampleId;
        row[COL['OBSERVATION TYPE']] = 'Traveling';
        row[COL['PROTOCOL CODE']] = 'P22';
        row[COL['PROJECT NAMES']] = 'EBIRD';
        row[COL['DURATION MINUTES']] = String(duration);
        row[COL['EFFORT DISTANCE KM']] = (random() * 8).toFixed(3);
        row[COL['NUMBER OBSERVERS']] = String(1 + Math.floor(random() * 4));
        row[COL['ALL SPECIES REPORTED']] = complete ? '1' : '0';
        row[COL['HAS MEDIA']] = '0';
        row[COL.APPROVED] = '1';
        row[COL.REVIEWED] = '0';
        row[COL['PROTOCOL NAME']] = 'Traveling';
        if (random() < REFERENCE.commentRate) {
          row[COL['SPECIES COMMENTS']] = makeComment();
        }
        if (checklistComment) row[COL['CHECKLIST COMMENTS']] = checklistComment;
        buffer += `${row.join('\t')}\n`;
        records += 1;
      }
      if (buffer.length > 4 << 20) {
        await write(buffer);
        buffer = '';
      }
    }
  }
  if (buffer) await write(buffer);
  stream.end();
  await once(stream, 'finish');

  console.log(
    JSON.stringify({
      out,
      scale,
      records,
      checklists: totalChecklists,
      locations: locations.length,
      speciesPool: speciesPool.length,
    }),
  );
};

await run();
