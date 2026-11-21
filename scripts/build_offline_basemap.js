// Builds public/offline-basemap.json, the simple world map shown when Mapbox tiles are
// unavailable offline. Source: Natural Earth 1:10m (public domain, naturalearthdata.com).
//
// Usage: node scripts/build_offline_basemap.js <folder with the unzipped Natural Earth layers>
// The folder holds ne_10m_ocean/, ne_10m_lakes/, ne_10m_rivers_lake_centerlines/,
// ne_10m_admin_0_boundary_lines_land/, ne_10m_admin_1_states_provinces_lines/, ne_10m_roads/,
// ne_10m_populated_places_simple/ and the more detailed supplements ne_10m_lakes_europe/,
// ne_10m_lakes_north_america/, ne_10m_rivers_europe/ and ne_10m_rivers_north_america/, each
// unzipped from naciscdn.org/naturalearth/10m/.
// Needs GDAL's ogr2ogr on the PATH.
//
// Every ring and line is stored as a polyline string with 3 decimals (~100 m), several
// times smaller than GeoJSON. The app decodes it with @mapbox/polyline.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import polyline from '@mapbox/polyline';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(projectRoot, 'public/offline-basemap.json');
const source = process.argv[2];
if (!source) throw new Error('Pass the folder holding the unzipped Natural Earth layers.');

const PRECISION = 3;
const read = (layer, sql, tolerance) => {
  const args = ['-f', 'GeoJSON', '/vsistdout/', path.join(source, layer, layer + '.shp')];
  args.push('-dialect', 'sqlite', '-sql', sql, '-lco', `COORDINATE_PRECISION=${PRECISION}`);
  if (tolerance) args.push('-simplify', String(tolerance));
  const json = execFileSync('ogr2ogr', args, { maxBuffer: 1 << 30, encoding: 'utf8' });
  return JSON.parse(json).features.filter((feature) => feature.geometry);
};
const encode = (coordinates) =>
  polyline.encode(
    coordinates.map(([lng, lat]) => [lat, lng]),
    PRECISION,
  );
const polygons = (features) =>
  features
    .flatMap(({ geometry: g }) =>
      (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((rings) =>
        rings.filter((ring) => ring.length >= 4).map(encode),
      ),
    )
    .filter((rings) => rings.length);
const lines = (features) =>
  features.flatMap(({ geometry: g }) =>
    (g.type === 'LineString' ? [g.coordinates] : g.coordinates)
      .filter((line) => line.length >= 2)
      .map(encode),
  );
const roads = (type) =>
  lines(
    read(
      'ne_10m_roads',
      `SELECT geometry FROM ne_10m_roads WHERE "type" = '${type}' AND continent != 'Antarctica'`,
      0.004,
    ),
  );

const basemap = {
  source: 'Natural Earth 1:10m, public domain',
  water: polygons([
    ...read('ne_10m_ocean', 'SELECT geometry FROM ne_10m_ocean', 0.002),
    ...['ne_10m_lakes', 'ne_10m_lakes_europe', 'ne_10m_lakes_north_america'].flatMap((layer) =>
      read(layer, `SELECT geometry FROM ${layer}`, 0.002),
    ),
  ]),
  river: lines(
    [
      'ne_10m_rivers_lake_centerlines',
      'ne_10m_rivers_europe',
      'ne_10m_rivers_north_america',
    ].flatMap((layer) =>
      read(layer, `SELECT geometry FROM ${layer} WHERE featurecla LIKE 'River%'`, 0.003),
    ),
  ),
  country: lines(
    read(
      'ne_10m_admin_0_boundary_lines_land',
      'SELECT geometry FROM ne_10m_admin_0_boundary_lines_land',
      0.002,
    ),
  ),
  region: lines(
    read(
      'ne_10m_admin_1_states_provinces_lines',
      'SELECT geometry FROM ne_10m_admin_1_states_provinces_lines',
      0.005,
    ),
  ),
  majorRoad: roads('Major Highway'),
  road: roads('Secondary Highway'),
  // [longitude, latitude, scalerank (0 = largest), name]
  place: read(
    'ne_10m_populated_places_simple',
    'SELECT geometry, scalerank, name FROM ne_10m_populated_places_simple ORDER BY scalerank',
  ).map(({ geometry, properties }) => [
    ...geometry.coordinates,
    properties.scalerank,
    properties.name,
  ]),
};
fs.writeFileSync(outputPath, JSON.stringify(basemap));
console.log(`Wrote ${outputPath} (${(fs.statSync(outputPath).size / 1e6).toFixed(1)} MB)`);
