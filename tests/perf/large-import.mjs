import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import JSZip from 'jszip';
import {
  createEbdImportAccumulator,
  finalizeEbdImport,
  streamEbdZipEntry,
} from '../../src/utils/ebdImport.js';

const archivePath = process.argv[2];
if (!archivePath) {
  throw new Error('Usage: npm run perf:large-import -- /path/to/ebd.zip');
}

const taxonomy = JSON.parse(
  await readFile(new URL('../../src/assets/eBird_taxonomy.json', import.meta.url)),
);
const taxonomyByScientificName = Object.fromEntries(
  taxonomy.filter((row) => row.sciName).map((row) => [row.sciName, row]),
);
const taxonomyByCode = Object.fromEntries(
  taxonomy.filter((row) => row.speciesCode).map((row) => [row.speciesCode, row]),
);

const archive = await readFile(archivePath);
const zip = await JSZip.loadAsync(archive);
const entry = Object.values(zip.files).reduce((largest, candidate) => {
  if (!candidate.name.toLowerCase().endsWith('.txt') || !candidate._data) return largest;
  return !largest || candidate._data.uncompressedSize > largest._data.uncompressedSize
    ? candidate
    : largest;
}, null);
const accumulator = createEbdImportAccumulator(taxonomyByScientificName, taxonomyByCode);
const startedAt = performance.now();
let displayedProgress = -1;

await streamEbdZipEntry(entry, accumulator, (progress) => {
  const roundedProgress = Math.floor(progress / 10) * 10;
  if (roundedProgress === displayedProgress) return;
  displayedProgress = roundedProgress;
  const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  console.log(
    `${roundedProgress}%: ${accumulator.recordCount.toLocaleString()} records, ${heapMb} MB heap`,
  );
});

const result = finalizeEbdImport(accumulator);
const importSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
const importHeapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
const tripStartedAt = performance.now();
const locations = new Map();

for (const checklist of result.checklists) {
  const localityId = checklist.location.locality_id;
  let location = locations.get(localityId);
  if (!location) {
    location = {
      ...checklist.location,
      checklist_count_complete: 0,
      checklist_count_incomplete: 0,
      speciesChecklistCounts: new Map(),
      checklist: [],
    };
    locations.set(localityId, location);
  }

  if (!checklist.all_species_reported) {
    location.checklist_count_incomplete++;
    continue;
  }

  location.checklist_count_complete++;
  for (const species of checklist.species) {
    location.speciesChecklistCounts.set(
      species.code,
      (location.speciesChecklistCounts.get(species.code) || 0) + 1,
    );
  }
  location.checklist.push({
    checklist_id: checklist.checklist_id,
    date: checklist.date,
    time: checklist.time,
    duration_minutes: checklist.duration_minutes,
    effort_distance_km: checklist.effort_distance_km,
    all_species_reported: true,
    species: checklist.species,
  });
}

const tripLocations = Array.from(locations.values(), (location) => ({
  ...location,
  checklist_count: location.checklist_count_complete,
  species_checklist_counts: Array.from(location.speciesChecklistCounts.entries()),
  speciesChecklistCounts: undefined,
}));
const tripBuildSeconds = Math.round((performance.now() - tripStartedAt) / 100) / 10;
const tripBuildHeapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

console.table({
  records: result.recordCount.toLocaleString(),
  checklists: result.checklists.length.toLocaleString(),
  locations: tripLocations.length.toLocaleString(),
  importSeconds,
  importHeapMb,
  tripBuildSeconds,
  tripBuildHeapMb,
});
