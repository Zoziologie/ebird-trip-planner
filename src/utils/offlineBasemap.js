// Simple world map (Natural Earth, see scripts/build_offline_basemap.js) drawn where Mapbox
// tiles fail to load, so the map still shows coasts, lakes, rivers, borders, main roads and
// towns offline. It fills only failed tiles with no cached tile one or two zooms up: Mapbox
// stretches those itself, and areas cached while planning stay pure Mapbox.
// If the Mapbox style itself is not cached, the map switches to a style made of it alone.
import polyline from '@mapbox/polyline';
import { bboxClip } from '@turf/turf';

const PRECISION = 3;
const LINE_KINDS = ['river', 'country', 'region', 'majorRoad', 'road'];
const SOURCE = 'offline-basemap';
const FONT = ['DIN Pro Regular', 'Arial Unicode MS Regular'];
const COLORS = { land: '#f0f1e9', water: '#c6dde3' };
const PREFIX = 'offline-basemap-';

let dataPromise;
const loadData = () =>
  (dataPromise ||= fetch(`${import.meta.env.BASE_URL}offline-basemap.json`)
    .then((response) => {
      if (!response.ok) throw new Error(`Offline map unavailable (${response.status}).`);
      return response.json();
    })
    .then(decode)
    .catch((failure) => {
      dataPromise = undefined;
      throw failure;
    }));

function bounds(coordinates) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of coordinates) {
    if (x < box[0]) box[0] = x;
    if (y < box[1]) box[1] = y;
    if (x > box[2]) box[2] = x;
    if (y > box[3]) box[3] = y;
  }
  return box;
}
const decodeLine = (text) => polyline.decode(text, PRECISION).map(([lat, lng]) => [lng, lat]);
function decode(raw) {
  const items = [];
  for (const rings of raw.water) {
    if (!rings.length) continue;
    const coordinates = rings.map(decodeLine);
    items.push({
      box: bounds(coordinates[0]),
      feature: {
        type: 'Feature',
        properties: { kind: 'water' },
        geometry: { type: 'Polygon', coordinates },
      },
    });
  }
  for (const kind of LINE_KINDS)
    for (const text of raw[kind]) {
      const coordinates = decodeLine(text);
      items.push({
        box: bounds(coordinates),
        feature: {
          type: 'Feature',
          properties: { kind },
          geometry: { type: 'LineString', coordinates },
        },
      });
    }
  for (const [lng, lat, rank, name] of raw.place)
    items.push({
      box: [lng, lat, lng, lat],
      feature: {
        type: 'Feature',
        properties: { kind: 'place', rank, name },
        geometry: { type: 'Point', coordinates: [lng, lat] },
      },
    });
  return items;
}

// Tiles are keyed `tileset|z/x/y`, tileset as in the Mapbox tile URL ('' when unknown).
const tileOf = (key) => key.split('|')[1].split('/').map(Number);
// Web Mercator tile → [west, south, east, north].
function tileBounds(key) {
  const [z, x, y] = tileOf(key);
  const n = 2 ** z;
  const lat = (row) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
}
// Tiles saved by the service worker (and Mapbox's own cache), as `tileset/z/x/y`.
async function cachedTiles() {
  const tiles = new Set();
  for (const name of ['mapbox-map-tiles', 'mapbox-tiles']) {
    if (!(await caches.has(name))) continue;
    for (const request of await (await caches.open(name)).keys()) {
      const match = /\/v4\/([^/]+)\/(\d+)\/(\d+)\/(\d+)[.@]/.exec(new URL(request.url).pathname);
      if (match) tiles.add(match.slice(1).join('/'));
    }
  }
  return tiles;
}
function stretchable(key, cached) {
  const tileset = key.split('|')[0];
  const [z, x, y] = tileOf(key);
  for (let k = 1; k <= 2 && k <= z; k++)
    if (cached.has(`${tileset}/${z - k}/${x >> k}/${y >> k}`)) return true;
  return false;
}
const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
function clip(items, box) {
  // The mask hides Mapbox's stretched low-zoom leftovers under the simple map.
  const [west, south, east, north] = box;
  const features = [
    {
      type: 'Feature',
      properties: { kind: 'mask' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
          ],
        ],
      },
    },
  ];
  for (const { box: itemBox, feature } of items) {
    if (!overlaps(itemBox, box)) continue;
    if (feature.geometry.type === 'Point') {
      features.push(feature);
      continue;
    }
    const clipped = bboxClip(feature, box);
    const parts = clipped.geometry.coordinates;
    if (parts.length && parts.some((part) => part.length)) features.push(clipped);
  }
  return features;
}

function layers(colors) {
  const kind = (value) => ['==', ['get', 'kind'], value];
  const line = (id, color, width, extra = {}) => ({
    id: PREFIX + id,
    type: 'line',
    source: SOURCE,
    filter: kind(id),
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': color, 'line-width': width, ...extra },
  });
  const zoomWidth = (low, high) => ['interpolate', ['linear'], ['zoom'], 4, low, 12, high];
  return [
    {
      id: PREFIX + 'mask',
      type: 'fill',
      source: SOURCE,
      filter: kind('mask'),
      paint: { 'fill-color': colors.land },
    },
    {
      id: PREFIX + 'water',
      type: 'fill',
      source: SOURCE,
      filter: kind('water'),
      paint: { 'fill-color': colors.water },
    },
    line('river', colors.water, zoomWidth(0.6, 2.5)),
    line('region', '#9b9a8c', zoomWidth(0.4, 1), { 'line-dasharray': [3, 2] }),
    line('country', '#8a7f8e', zoomWidth(0.8, 2)),
    line('road', '#d9b38c', zoomWidth(0.5, 2.5)),
    line('majorRoad', '#d08a4e', zoomWidth(0.8, 3.5)),
    {
      id: PREFIX + 'place',
      type: 'symbol',
      source: SOURCE,
      filter: ['all', kind('place'), ['<=', ['get', 'rank'], ['+', ['zoom'], 2]]],
      layout: {
        'text-field': ['get', 'name'],
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['get', 'rank'], 0, 14, 10, 11],
        'symbol-sort-key': ['get', 'rank'],
      },
      paint: { 'text-color': '#45433c', 'text-halo-color': colors.land, 'text-halo-width': 1.5 },
    },
  ];
}

const fallbackStyle = () => ({
  version: 8,
  glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': COLORS.land } }],
});

// restore() puts the normal Mapbox style back once the device is online again.
export function attachOfflineBasemap(map, { signal, restore }) {
  const failed = new Map(); // tile key → clipped features, for tiles drawn from the world map
  let whole = false; // the Mapbox style itself failed: draw the world map in view
  let pending;

  function install() {
    if (!map.style?.stylesheet || map.getSource(SOURCE)) return;
    const style = map.getStyle();
    const background = style.layers.find((layer) => layer.type === 'background');
    const water = style.layers.find((layer) => layer.id === 'water' && layer.type === 'fill');
    const colors = {
      land: (background && map.getPaintProperty(background.id, 'background-color')) || COLORS.land,
      water: (water && map.getPaintProperty(water.id, 'fill-color')) || COLORS.water,
    };
    if (typeof colors.land !== 'string') colors.land = COLORS.land;
    if (typeof colors.water !== 'string') colors.water = COLORS.water;
    // Above the Mapbox layers (the mask covers what they stretch from lower zooms), below
    // the trip overlays.
    const mapbox = (layer) =>
      layer.type === 'background' ||
      String(style.sources[layer.source]?.url || '').startsWith('mapbox://');
    const before = style.layers[style.layers.findLastIndex(mapbox) + 1]?.id;
    map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    for (const layer of layers(colors)) map.addLayer(layer, before);
  }
  async function refresh() {
    pending = undefined;
    if (signal.aborted || !(whole || failed.size)) return;
    let items;
    try {
      items = await loadData();
    } catch {
      return;
    }
    const cached = [...failed.values()].some((value) => !value)
      ? await cachedTiles().catch(() => new Set())
      : new Set();
    if (signal.aborted) return;
    install();
    const features = [];
    for (const [key, clipped] of failed) {
      if (!clipped) failed.set(key, stretchable(key, cached) ? [] : clip(items, tileBounds(key)));
      features.push(...failed.get(key));
    }
    map.getSource(SOURCE)?.setData({ type: 'FeatureCollection', features });
  }
  const schedule = () => (pending ||= setTimeout(refresh, 150));
  const add = (key) => {
    if (failed.has(key)) return;
    failed.set(key, null);
    // Keep memory bounded on long pans: drop the oldest squares first.
    for (const old of failed.keys()) {
      if (failed.size <= 300) break;
      failed.delete(old);
    }
    schedule();
  };
  // With no Mapbox style there are no tile errors to follow: draw the tiles in view.
  const addVisible = () => {
    if (!whole) return;
    const z = Math.max(0, Math.min(14, Math.floor(map.getZoom())));
    const n = 2 ** z;
    const bounds = map.getBounds();
    const column = (lng) => Math.min(n - 1, Math.max(0, Math.floor(((lng + 180) / 360) * n)));
    const row = (lat) => {
      const rad = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
      const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
      return Math.min(n - 1, Math.max(0, Math.floor(y)));
    };
    for (let x = column(bounds.getWest()); x <= column(bounds.getEast()); x++)
      for (let y = row(bounds.getNorth()); y <= row(bounds.getSouth()); y++) add(`|${z}/${x}/${y}`);
  };

  const onError = (event) => {
    if (navigator.onLine) return;
    if (event.tile) {
      // A missing relief tile does not leave the map blank.
      if (event.source?.type === 'raster-dem') return;
      const { z, x, y } = event.tile.tileID.canonical;
      const tileset = String(event.source?.url || '').replace('mapbox://', '');
      add(`${tileset}|${z}/${x}/${y}`);
    } else if (!map.style?.stylesheet) {
      // The Mapbox style was never cached on this device (or not this basemap).
      whole = true;
      failed.clear();
      map.setStyle(fallbackStyle(), { diff: false });
    }
  };
  // Cached areas reload fine at other zooms: keep only squares near the current zoom so
  // the coarse map never sits under detailed Mapbox data.
  const onZoom = () => {
    const zoom = Math.floor(map.getZoom());
    let changed = false;
    for (const key of failed.keys())
      if (Math.abs(tileOf(key)[0] - zoom) > 1) changed = failed.delete(key);
    if (changed) schedule();
  };
  const onStyle = () => {
    addVisible();
    if (failed.size) {
      install();
      schedule();
    }
  };
  const onOnline = () => {
    failed.clear();
    if (whole) {
      whole = false;
      restore();
    } else map.getSource(SOURCE)?.setData({ type: 'FeatureCollection', features: [] });
  };
  map.on('error', onError);
  map.on('zoomend', onZoom);
  map.on('moveend', addVisible);
  map.on('style.load', onStyle);
  window.addEventListener('online', onOnline, { signal });
  if (!navigator.onLine) loadData().catch(() => {});
  signal.addEventListener('abort', () => {
    clearTimeout(pending);
    map.off('error', onError);
    map.off('zoomend', onZoom);
    map.off('moveend', addVisible);
    map.off('style.load', onStyle);
  });
}
