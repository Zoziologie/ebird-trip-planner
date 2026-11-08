import taxonomy from '../assets/eBird_taxonomy.json';

const trimToString = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeTaxonCategory = (value) => trimToString(value).toLowerCase();

const pickFirstString = (source, keys) => {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
};

const TAXON_FIELD_KEYS = {
  speciesCode: [
    'speciesCode',
    'code',
    'species_code',
    'taxonCode',
    'taxon_code',
    'speciesId',
    'species_id',
    'Species Code',
    'SPECIES CODE',
  ],
  scientificName: [
    'Scientific Name',
    'SCIENTIFIC NAME',
    'scientificName',
    'sciName',
    'scientific_name',
  ],
  commonName: ['commonName', 'comName', 'common_name', 'Common Name', 'COMMON NAME'],
  category: [
    'category',
    'Category',
    'CATEGORY',
    'taxonCategory',
    'taxon_category',
    'Taxon Category',
    'TAXON CATEGORY',
  ],
  reportAs: ['reportAs', 'report_as', 'REPORT_AS', 'Report As', 'REPORT AS'],
  countable: ['Countable', 'COUNTABLE', 'countable'],
};

export const isCountableTaxon = (source) => {
  const raw = pickFirstString(source, TAXON_FIELD_KEYS.countable);
  if (!raw) return true;
  const normalized = raw.toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

export const extractTaxonFields = (source = {}) => ({
  speciesCode: pickFirstString(source, TAXON_FIELD_KEYS.speciesCode),
  scientificName: pickFirstString(source, TAXON_FIELD_KEYS.scientificName),
  commonName: pickFirstString(source, TAXON_FIELD_KEYS.commonName),
  category: pickFirstString(source, TAXON_FIELD_KEYS.category),
  reportAs: pickFirstString(source, TAXON_FIELD_KEYS.reportAs),
});

export const taxonomyByScientificName = taxonomy.reduce((acc, row) => {
  if (row?.sciName) {
    acc[row.sciName] = row;
  }
  return acc;
}, {});

export const taxonomyByCode = taxonomy.reduce((acc, row) => {
  if (row?.speciesCode) {
    acc[row.speciesCode] = row;
  }
  return acc;
}, {});

const getReportAsCode = (taxon) =>
  trimToString(taxon?.reportAs || taxon?.REPORT_AS || taxon?.report_as);

const resolveSpeciesFromTaxonRow = (taxonRow, fallbackReportAs = '') => {
  let current = taxonRow || null;
  let pendingReportAs = trimToString(fallbackReportAs);
  const visited = new Set();

  while (current && normalizeTaxonCategory(current.category) !== 'species') {
    pendingReportAs = getReportAsCode(current) || pendingReportAs;
    if (!pendingReportAs || visited.has(pendingReportAs)) {
      return null;
    }
    visited.add(pendingReportAs);
    current = taxonomyByCode[pendingReportAs] || null;
    pendingReportAs = '';
  }

  if (!current && pendingReportAs) {
    current = taxonomyByCode[pendingReportAs] || null;
  }

  if (!current) return null;
  return normalizeTaxonCategory(current.category) === 'species' ? current : null;
};

export const resolveSpeciesTaxon = ({
  speciesCode = '',
  scientificName = '',
  category = '',
  reportAs = '',
} = {}) => {
  const normalizedCode = trimToString(speciesCode);
  const normalizedScientificName = trimToString(scientificName);
  const explicitCategory = normalizeTaxonCategory(category);

  const taxonRow =
    (normalizedCode && taxonomyByCode[normalizedCode]) ||
    (normalizedScientificName && taxonomyByScientificName[normalizedScientificName]) ||
    null;

  const resolvedTaxon = resolveSpeciesFromTaxonRow(taxonRow, reportAs);
  if (resolvedTaxon) return resolvedTaxon;

  if (explicitCategory && explicitCategory !== 'species') return null;
  if (taxonRow && normalizeTaxonCategory(taxonRow.category) !== 'species') return null;
  if (!normalizedCode && !normalizedScientificName) return null;

  return {
    speciesCode: normalizedCode || normalizedScientificName,
    sciName: normalizedScientificName,
    comName: '',
    category: 'species',
    taxonOrder: Infinity,
  };
};
