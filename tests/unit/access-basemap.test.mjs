import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAccessBasemap } from '../../src/utils/accessBasemap.js';

test('access styling promotes paths and useful POIs without duplicating ordinary labels', () => {
  const layers = [
    { id: 'road-path', type: 'line', 'source-layer': 'road', minzoom: 12, paint: {} },
    {
      id: 'poi-label',
      type: 'symbol',
      source: 'composite',
      'source-layer': 'poi_label',
      filter: ['==', ['geometry-type'], 'Point'],
      layout: { 'text-field': ['get', 'name'] },
      paint: {},
    },
  ];
  const map = {
    getStyle: () => ({ layers }),
    getLayer: (id) => layers.find((layer) => layer.id === id),
    setLayerZoomRange: (id, minzoom) => {
      map.getLayer(id).minzoom = minzoom;
    },
    setPaintProperty: (id, key, value) => {
      map.getLayer(id).paint[key] = value;
    },
    setFilter: (id, filter) => {
      map.getLayer(id).filter = filter;
    },
    addLayer: (layer, before) =>
      layers.splice(
        layers.findIndex((item) => item.id === before),
        0,
        layer,
      ),
  };
  applyAccessBasemap(map);
  assert.equal(map.getLayer('road-path').minzoom, 11);
  assert.equal(map.getLayer('road-path').paint['line-opacity'], 1);
  assert.equal(map.getLayer('planning-access-pois').minzoom, 11);
  assert.match(JSON.stringify(map.getLayer('planning-access-pois').filter), /parking/);
  assert.match(JSON.stringify(map.getLayer('planning-access-pois').filter), /observation-tower/);
  assert.deepEqual(map.getLayer('poi-label').filter[2], [
    '!',
    map.getLayer('planning-access-pois').filter,
  ]);
  assert.ok(
    layers.findIndex((layer) => layer.id === 'planning-access-pois') <
      layers.findIndex((layer) => layer.id === 'poi-label'),
  );
});
