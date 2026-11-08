import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const envPath = path.join(projectRoot, '.env');
const outputPath = path.join(projectRoot, 'src/assets/eBird_taxonomy.json');

// The eBird payload carries family/banding/code fields the app never reads. It
// ships inside the JS bundle, so keep only what is actually used: doing so more
// than halves the download, the parse cost and the resident size.
const TAXONOMY_FIELDS = ['sciName', 'comName', 'speciesCode', 'category', 'taxonOrder', 'reportAs'];

const slimTaxonomy = (rows) =>
  rows.map((row) => {
    const slim = {};
    for (const field of TAXONOMY_FIELDS) {
      const value = row[field];
      if (value !== undefined && value !== null && value !== '') slim[field] = value;
    }
    return slim;
  });

const loadEnvFile = (filePath) => {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key]) continue;

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
};

loadEnvFile(envPath);
const token = (process.env.EBIRD_API_TOKEN || '').trim();

if (!token) {
  console.error('❌ Missing EBIRD_API_TOKEN. Set it in your shell or in .env.');
  process.exit(1);
}

https
  .get(
    'https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=json',
    {
      headers: {
        'X-eBirdApiToken': token,
      },
    },
    (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`❌ Failed with status ${res.statusCode}: ${res.statusMessage}`);
          if (data) console.error(data);
          process.exitCode = 1;
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch (error) {
          console.error(`❌ Invalid JSON payload from eBird API: ${error.message}`);
          process.exitCode = 1;
          return;
        }

        if (!Array.isArray(parsed)) {
          console.error('❌ Unexpected taxonomy payload: expected an array.');
          process.exitCode = 1;
          return;
        }

        fs.writeFileSync(outputPath, JSON.stringify(slimTaxonomy(parsed)), 'utf8');
        console.log(`✅ Fetched and saved ${parsed.length} taxa to ${outputPath}`);
      });
    },
  )
  .on('error', (error) => {
    console.error(`❌ Error: ${error.message}`);
    process.exitCode = 1;
  });
