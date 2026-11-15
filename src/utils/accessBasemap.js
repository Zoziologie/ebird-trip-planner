// Promote useful access features already available in Mapbox Streets.
export function applyAccessBasemap(map, satellite) {
  for (const id of ['road-path', 'road-pedestrian', 'road-street', 'road-minor']) {
    const layer = map.getLayer(id);
    if (!layer) continue;
    const path = id === 'road-path' || id === 'road-pedestrian';
    map.setLayerZoomRange(id, 11, layer.maxzoom || 24);
    const pathColor = satellite ? '#ffe08a' : '#a75418';
    const roadColor = satellite ? '#ffffff' : '#736550';
    map.setPaintProperty(id, 'line-color', path ? pathColor : roadColor);
    map.setPaintProperty(id, 'line-width', [
      'interpolate',
      ['linear'],
      ['zoom'],
      11,
      path ? 0.8 : 1,
      15,
      path ? 2 : 3,
      19,
      path ? 4 : 7,
    ]);
    map.setPaintProperty(id, 'line-opacity', 1);
  }
  const poi = map
    .getStyle()
    .layers.find((layer) => layer.type === 'symbol' && layer['source-layer'] === 'poi_label');
  if (!poi) return;
  const useful = [
    'any',
    [
      'match',
      ['get', 'maki'],
      [
        'parking',
        'parking-garage',
        'viewpoint',
        'picnic-site',
        'campsite',
        'toilet',
        'drinking-water',
        'information',
        'entrance',
      ],
      true,
      false,
    ],
    ['==', ['get', 'maki_beta'], 'observation-tower'],
    [
      'match',
      ['downcase', ['coalesce', ['get', 'type'], '']],
      ['bird hide', 'bird watching', 'birdwatching', 'observation tower', 'viewpoint'],
      true,
      false,
    ],
  ];
  const access = structuredClone(poi);
  access.id = 'planning-access-pois';
  access.minzoom = 11;
  access.filter = useful;
  access.layout = {
    ...access.layout,
    'text-size': ['interpolate', ['linear'], ['zoom'], 11, 11, 16, 14],
    'icon-size': 1.2,
    'text-optional': true,
  };
  access.paint = {
    ...access.paint,
    'text-color': satellite ? '#ffffff' : '#253c32',
    'text-halo-color': satellite ? '#253c32' : '#ffffff',
    'text-halo-width': 2,
    'icon-opacity': 1,
  };
  map.setFilter(poi.id, ['all', poi.filter || true, ['!', useful]]);
  map.addLayer(access, poi.id);
}
