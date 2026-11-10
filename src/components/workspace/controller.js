import mapboxgl from 'mapbox-gl';
import hotspotIcon from './report-hotspot.svg';
import personalIcon from './report-personal.svg';
import Papa from 'papaparse';
import { resolveSpeciesTaxon, extractTaxonFields, isCountableTaxon } from '../../utils/taxonomy.js';
import MapboxGeocoder from '@mapbox/mapbox-gl-geocoder';
import { featureCollection, point, distance, circle, destination } from '@turf/turf';
import { buildCommentMarkdown, copyMarkdown, downloadMarkdown } from '../../utils/commentExport.js';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css';
import 'bootstrap-icons/font/bootstrap-icons.css';

import { workspaceSpatialIndex } from '../../utils/workspaceSpatial';
import { workspaceModelPlan } from '../../utils/workspaceModel';
import { tripTimeZone } from '../../utils/tripTimeZone';
import polyline from '@mapbox/polyline';
import { compactRouteGeometry } from '../../utils/routeGeometry';
import { normalizeWorkspaceReportId, loadWorkspaceReport } from '../../utils/workspaceReport';

// The reviewed workspace interaction controller, mounted and disposed by Vue.
export function mountWorkspace(root, model, options) {
  const data = model;
  const abort = new AbortController();
  let disposed = false,
    reportRequest = 0;
  const elements = new Map([...root.querySelectorAll('[id]')].map((el) => [el.id, el]));
  const $ = (id) => elements.get(id);
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const displayDefaults = {
    'datetime-field': 'default',
    'duration-field': 'default',
    'interest-details': 'detail',
    'note-details': 'detail',
    'historical-stats': 'detail',
    'recorded-stats': 'detail',
    'comments-panel': 'detail',
  };
  const preferences = {
    mapStyle: 'outdoors-v12',
    fields: { ...displayDefaults },
    ...JSON.parse(localStorage.getItem('workspace-display') || '{}'),
  };
  const savePreferences = () =>
    localStorage.setItem('workspace-display', JSON.stringify(preferences));
  const icons = {
    Birding: 'feather',
    Accommodation: 'house-door',
    Airport: 'airplane',
    Food: 'cup-hot',
    Waypoint: 'geo-alt',
  };
  const taxa = new Map(data.taxa.map((item) => [item.code, { ...item }]));
  let stops = structuredClone(data.stops),
    selected = stops.find((s) => s.type === 'Birding')?.id || stops[0]?.id || 0,
    view = options.initialView || 'map',
    preview = false,
    basemap = 'outdoor',
    layer = '',
    reportId = data.reportId,
    synced = data.reportChecklists.length > 0,
    clusterFeatures = [],
    busy = false;
  const checked = new Set();
  let speciesSort = 'rank',
    speciesDirection = 1,
    lastDetailStop = 0;
  const globalEbdCounts = new Map();
  let globalEbdTotal = 0;
  for (const l of data.ebdLocations) {
    globalEbdTotal += l.totalCount;
    for (const [code, n] of Object.entries(l.counts))
      globalEbdCounts.set(code, (globalEbdCounts.get(code) || 0) + n);
  }
  const undoStack = [],
    redoStack = [];
  let typingKey = '',
    typingAt = 0;
  const routes = new Map(stops.filter((s) => s.route.geometry).map((s) => [s.id, s.route]));
  const markers = new Map();
  let areaHandles = [],
    dragging = false,
    popup = null,
    popupPinned = false,
    hoverKey = '';
  const active = () => stops.find((s) => s.id === selected);
  const writable = () => !options.visitor && !preview;
  let clockKey = '',
    clockValue = '',
    clockFormatter;
  const stage = () => {
    const today = cutoff().slice(0, 10);
    return today < data.start ? 'before' : today > data.end ? 'after' : 'during';
  };
  const cutoff = () => {
    const zone = tripTimeZone(data.timeZone, stops[0]?.coords[1], stops[0]?.coords[0]);
    const key = Math.floor(Date.now() / 60000) + ':' + zone;
    if (key !== clockKey) {
      if (!clockFormatter || !clockKey.endsWith(':' + zone))
        clockFormatter = new Intl.DateTimeFormat('sv-SE', {
          timeZone: zone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        });
      clockValue = clockFormatter.format(new Date()).replace(' ', 'T');
      clockKey = key;
    }
    return clockValue;
  };
  const dateFormatter = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
  const dateLabel = (value) => dateFormatter.format(new Date(value));
  const driveLabel = (seconds) => {
    const minutes = Math.round(seconds / 60);
    return [
      Math.floor(minutes / 1440) ? Math.floor(minutes / 1440) + 'd' : '',
      Math.floor((minutes % 1440) / 60) ? Math.floor((minutes % 1440) / 60) + 'h' : '',
      minutes % 60 || !minutes ? (minutes % 60) + 'min' : '',
    ].join('');
  };
  const dayFormatter = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const timeLabel = (value) => value.slice(11, 16);
  const feedback = (text) => {
    $('feedback').textContent = text;
  };
  let reportSource,
    reportKey = '',
    visibleReport = [];
  const reportChecklists = () => {
    const key = cutoff() + ':' + synced + ':' + stage();
    if (reportSource !== data.reportChecklists || key !== reportKey) {
      reportSource = data.reportChecklists;
      reportKey = key;
      visibleReport =
        synced && stage() !== 'before'
          ? data.reportChecklists.filter((c) => c.date <= cutoff())
          : [];
      reportAggregates.clear();
    }
    return visibleReport;
  };
  const reportAggregates = new Map();
  const spatialQuery = workspaceSpatialIndex(data.ebdLocations),
    stopLocations = new Map();
  let selectionStatsKey = '',
    planningCache = null,
    planningKey = '';
  function computeSpatial(stop) {
    const locations = stop.type === 'Birding' ? spatialQuery(stop.coords, stop.radius) : [];
    stopLocations.set(stop.id, locations);
    stop.historicalCount = 0;
    stop.historicalSpecies = {};
    for (const l of locations) {
      stop.historicalCount += l.count;
      for (const [code, n] of Object.entries(l.counts))
        stop.historicalSpecies[code] = (stop.historicalSpecies[code] || 0) + n;
    }
    planningCache = null;
    selectionStatsKey = '';
  }
  // Spatial membership is independent of the planned visit date: aggregate all report dates through the snapshot.
  const memberships = new Map();
  for (const stop of stops)
    memberships.set(
      stop.id,
      new Set(
        stop.type === 'Birding'
          ? data.reportChecklists
              .filter((c) => distance(stop.coords, c.coords) <= stop.radius)
              .map((c) => c.id)
          : [],
      ),
    );
  function aggregation(stop) {
    const visible = reportChecklists(),
      key = stop?.id || 0;
    if (reportAggregates.has(key)) return reportAggregates.get(key);
    const lists = stop ? visible.filter((c) => memberships.get(stop.id)?.has(c.id)) : visible;
    const counts = new Map();
    for (const checklist of lists)
      for (const [code, count] of Object.entries(checklist.species)) {
        const previous = counts.get(code) || { individuals: 0, unknown: false, checklists: 0 };
        if (typeof count === 'number' && count > 0) previous.individuals += count;
        else previous.unknown = true;
        previous.checklists++;
        counts.set(code, previous);
      }
    const result = {
      lists,
      counts,
      missing: lists.filter((c) => !Object.keys(c.species).length).length,
    };
    reportAggregates.set(key, result);
    return result;
  }
  function reported(stop) {
    return reportChecklists().some((c) => memberships.get(stop.id)?.has(c.id));
  }
  function symbol(stop) {
    return '<i class="bi bi-' + (icons[stop.type] || 'geo-alt') + '" aria-hidden="true"></i>';
  }
  function temporal(stop) {
    return stop.date <= cutoff() ? 'past' : 'future';
  }
  mapboxgl.accessToken = 'pk.eyJ1IjoicmFmbnVzcyIsImEiOiIzMVE1dnc0In0.3FNMKIlQ_afYktqki-6m0g';
  let mapFitted = false;
  const map = new mapboxgl.Map({
    container: $('map'),
    style: 'mapbox://styles/mapbox/' + preferences.mapStyle,
    center: stops[0]?.coords || [0, 20],
    zoom: 5.2,
  });
  map.addControl(new mapboxgl.NavigationControl(), 'top-right');
  map.addControl(
    new mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserHeading: true,
    }),
    'top-right',
  );
  for (const event of ['click', 'dblclick', 'mousedown', 'touchstart'])
    $('map-tools').addEventListener(event, (e) => e.stopPropagation(), { signal: abort.signal });
  map.addControl(
    {
      onAdd() {
        return $('map-tools');
      },
      onRemove() {
        $('map-tools').remove();
      },
    },
    'top-right',
  );
  const geocoder = new MapboxGeocoder({
    accessToken: mapboxgl.accessToken,
    mapboxgl,
    marker: false,
    placeholder: 'Search location',
    localGeocoder: (query) =>
      stops
        .filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
        .map((s) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: s.coords },
          center: s.coords,
          place_name: s.name,
          place_type: ['poi'],
          properties: {},
          text: s.name,
        })),
  });
  $('geocoder').append(geocoder.onAdd(map));

  root.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') $('layers').open = false;
    },
    { signal: abort.signal },
  );
  root.addEventListener(
    'click',
    (event) => {
      if (!event.target.closest('#layers')) $('layers').open = false;
      if (
        $('workspace-layout').classList.contains('mobile') &&
        !event.target.closest('.header-menu')
      )
        root.querySelector('.header-menu').open = false;
    },
    { signal: abort.signal },
  );
  const resizeObserver = new ResizeObserver(() => map.resize());
  resizeObserver.observe($('map'));
  map.on('style.load', async () => {
    if (basemap === 'outdoor' && preferences.mapStyle === 'outdoors-v12') {
      for (const layer of map.getStyle().layers) {
        if (layer.type === 'background')
          map.setPaintProperty(layer.id, 'background-color', '#f0f1e9');
        if (layer.type === 'fill' && layer.id === 'water')
          map.setPaintProperty(layer.id, 'fill-color', '#dde9e7');
        if (layer.type === 'fill' && layer.id === 'landcover')
          map.setPaintProperty(layer.id, 'fill-opacity', 0.55);
      }
    }
    for (const name of ['hotspot', 'personal']) {
      const image = new Image(32, 40);
      image.src = name === 'hotspot' ? hotspotIcon : personalIcon;
      await image.decode();
      if (disposed) return;
      if (!map.hasImage('report-' + name)) map.addImage('report-' + name, image, { pixelRatio: 2 });
    }
    if (disposed) return;
    drawLayers();
    drawMarkers();
    if (!mapFitted) {
      fitTrip();
      mapFitted = true;
    }
  });
  function fitTrip() {
    const bounds = new mapboxgl.LngLatBounds();
    stops.forEach((s) => bounds.extend(s.coords));
    if (bounds.isEmpty()) return;
    map.fitBounds(bounds, {
      padding: $('workspace-layout').classList.contains('mobile')
        ? { top: 115, bottom: 120, left: 35, right: 45 }
        : 75,
      maxZoom: 10,
      duration: 300,
    });
  }
  const sourceData = new WeakMap();
  let ebdFeatures,
    reportFeatures,
    reportFeaturesLists,
    speciesFeatures,
    speciesFeaturesInput,
    routeFeatures,
    routeFeaturesKey = '';
  function setSource(id, data, options = {}) {
    let source = map.getSource(id);
    if (!source) {
      map.addSource(id, { type: 'geojson', data, ...options });
      source = map.getSource(id);
    } else if (sourceData.get(source) !== data) source.setData(data);
    sourceData.set(source, data);
  }
  function drawLayers() {
    if (disposed) return;
    if (!map.isStyleLoaded()) {
      map.once('idle', drawLayers);
      return;
    }
    drawArea();
    if (($('hotspots').checked || $('personal-locations').checked) && !ebdFeatures)
      ebdFeatures = featureCollection(
        data.ebdLocations.map((l) =>
          point(l.coords, {
            id: l.id,
            name: l.name,
            count: l.count,
            species: Object.keys(l.counts).length,
            hotspot: l.hotspot,
          }),
        ),
      );
    setSource('ebd', ebdFeatures || featureCollection([]));
    if (!map.getLayer('ebd'))
      map.addLayer({
        id: 'ebd',
        type: 'circle',
        source: 'ebd',
        paint: {
          'circle-color': ['case', ['get', 'hotspot'], '#59886e', '#c28c58'],
          'circle-radius': ['interpolate', ['linear'], ['get', 'count'], 1, 3, 50, 8, 500, 13],
          'circle-opacity': 0.78,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
        },
      });
    map.setFilter('ebd', [
      'any',
      ['all', ['==', ['get', 'hotspot'], true], $('hotspots').checked],
      ['all', ['==', ['get', 'hotspot'], false], $('personal-locations').checked],
    ]);
    map.setLayoutProperty(
      'ebd',
      'visibility',
      $('hotspots').checked || $('personal-locations').checked ? 'visible' : 'none',
    );
    const routeKey = JSON.stringify(stops.map((s) => [s.id, s.coords, routes.get(s.id)?.geometry]));
    if (routeFeaturesKey !== routeKey) {
      routeFeaturesKey = routeKey;
      routeFeatures = featureCollection(
        stops.slice(1).map((s, i) => ({
          type: 'Feature',
          properties: {},
          geometry: routes.get(s.id)?.geometry || {
            type: 'LineString',
            coordinates: [stops[i].coords, s.coords],
          },
        })),
      );
    }
    setSource('route', routeFeatures);
    if (!map.getLayer('route'))
      map.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        paint: { 'line-color': '#386d70', 'line-width': 2, 'line-opacity': 0.6 },
      });
    const lists = reportChecklists();
    if (reportFeaturesLists !== lists) {
      reportFeaturesLists = lists;
      reportFeatures = featureCollection(
        lists.map((c) =>
          point(c.coords, {
            id: c.id,
            name: c.name,
            icon: c.hotspot ? 'report-hotspot' : 'report-personal',
            date: c.date,
            species: c.declaredSpecies,
          }),
        ),
      );
    }
    const reportData = reportFeatures;
    setSource('report', reportData, { cluster: true, clusterRadius: 35, clusterMaxZoom: 10 });
    if (!map.getLayer('report-clusters')) {
      map.addLayer({
        id: 'report-clusters',
        type: 'circle',
        source: 'report',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#3476a6',
          'circle-radius': 16,
          'circle-stroke-color': 'white',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'report-count',
        type: 'symbol',
        source: 'report',
        filter: ['has', 'point_count'],
        layout: { 'text-field': '{point_count_abbreviated}', 'text-size': 11 },
        paint: { 'text-color': 'white' },
      });
      map.addLayer({
        id: 'report-pins',
        type: 'symbol',
        source: 'report',
        filter: ['!', ['has', 'point_count']],
        layout: {
          'icon-image': ['get', 'icon'],
          'icon-size': 1,
          'icon-anchor': 'bottom',
          'icon-allow-overlap': false,
        },
      });
    }
    for (const id of ['report-clusters', 'report-count', 'report-pins'])
      map.setLayoutProperty(
        id,
        'visibility',
        synced && (!writable() || $('report-layer').checked) ? 'visible' : 'none',
      );
    if (speciesFeaturesInput !== clusterFeatures) {
      speciesFeaturesInput = clusterFeatures;
      speciesFeatures = featureCollection(clusterFeatures);
    }
    setSource('species', speciesFeatures);
    if (!map.getLayer('species')) {
      map.addLayer({
        id: 'species',
        type: 'circle',
        source: 'species',
        paint: {
          'circle-color': [
            'interpolate',
            ['linear'],
            ['get', 'rate'],
            0,
            '#f4dcba',
            0.5,
            '#d78837',
            1,
            '#953d25',
          ],
          'circle-radius': ['interpolate', ['linear'], ['get', 'count'], 1, 5, 100, 13, 1000, 22],
          'circle-opacity': 0.8,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#875223',
        },
      });
    }
    map.setLayoutProperty('species', 'visibility', $('species-layer').checked ? 'visible' : 'none');
  }
  function drawArea() {
    if (disposed) return;
    if (!map.isStyleLoaded()) {
      map.once('idle', drawArea);
      return;
    }
    const stop = active();
    setSource(
      'stop-area',
      featureCollection(
        stop?.type === 'Birding' ? [circle(stop.coords, stop.radius, { units: 'kilometers' })] : [],
      ),
    );
    if (!map.getLayer('stop-area')) {
      map.addLayer({
        id: 'stop-area',
        type: 'fill',
        source: 'stop-area',
        paint: { 'fill-color': '#386d70', 'fill-opacity': 0.08 },
      });
      map.addLayer({
        id: 'stop-area-edge',
        type: 'line',
        source: 'stop-area',
        paint: { 'line-color': '#386d70', 'line-width': 1.5 },
      });
    }
  }
  // Geometry edits refresh both datasets locally; eBird's original checklists stay unchanged.
  function updateSpatial(stop, previousCoords = null) {
    memberships.set(
      stop.id,
      new Set(
        stop.type === 'Birding'
          ? data.reportChecklists
              .filter((c) => distance(stop.coords, c.coords) <= stop.radius)
              .map((c) => c.id)
          : [],
      ),
    );
    reportAggregates.clear();
    computeSpatial(stop);
    if (previousCoords && distance(previousCoords, stop.coords) >= 1 - 1e-9) {
      routes.delete(stop.id);
      const next = stops[stops.indexOf(stop) + 1];
      if (next) routes.delete(next.id);
    }
    renderList();
    renderEditor();
    renderSpecies();
    drawMarkers();
    drawLayers();
    queueSave();
  }
  function snapshot() {
    return { stops: structuredClone(stops), routes: structuredClone([...routes]), selected };
  }
  function renderHistory() {
    $('undo').disabled = !undoStack.length;
    $('redo').hidden = !redoStack.length;
  }
  function rememberEdit(key = '') {
    if (!key || key !== typingKey || Date.now() - typingAt > 900) undoStack.push(snapshot());
    if (undoStack.length > 50) undoStack.shift();
    typingKey = key;
    typingAt = Date.now();
    redoStack.length = 0;
    renderHistory();
    closePopup();
  }
  function restoreHistory(back = true) {
    const source = back ? undoStack : redoStack,
      target = back ? redoStack : undoStack;
    if (!writable() || !source.length) return;
    target.push(snapshot());
    installStops(source.pop());
    lastDetailStop = 0;
    renderHistory();
    renderList();
    renderEditor();
    renderSpecies();
    drawMarkers();
    drawLayers();
    queueSave();
  }
  function installStops(saved) {
    stops = saved.stops;
    selected = saved.selected;
    routes.clear();
    saved.routes.forEach(([id, r]) => routes.set(id, r));
    checked.clear();
    typingKey = '';
    planningCache = null;
    selectionStatsKey = '';
    for (const stop of stops)
      memberships.set(
        stop.id,
        new Set(
          stop.type === 'Birding'
            ? data.reportChecklists
                .filter((c) => distance(stop.coords, c.coords) <= stop.radius)
                .map((c) => c.id)
            : [],
        ),
      );
    reportAggregates.clear();
    for (const stop of stops) computeSpatial(stop);
  }
  $('undo').onclick = () => restoreHistory();
  $('redo').onclick = () => restoreHistory(false);
  root.addEventListener(
    'keydown',
    (e) => {
      if (e.target.id === 'target-search') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && writable()) {
        e.preventDefault();
        restoreHistory(!e.shiftKey);
      } else if (e.ctrlKey && e.key.toLowerCase() === 'y' && writable()) {
        e.preventDefault();
        restoreHistory(false);
      }
    },
    { signal: abort.signal },
  );

  function positionHandles(stop) {
    areaHandles.forEach((m, i) =>
      m.setLngLat(destination(stop.coords, stop.radius, i * 90).geometry.coordinates),
    );
  }
  function drawHandles() {
    areaHandles.forEach((m) => m.remove());
    areaHandles = [];
    const stop = active();
    if (!writable() || checked.size || stop?.type !== 'Birding') return;
    for (let i = 0; i < 4; i++) {
      const handle = document.createElement('button');
      handle.className = 'area-handle ' + (i % 2 ? 'horizontal' : 'vertical');
      handle.setAttribute(
        'aria-label',
        'Resize stop area ' + ['north', 'east', 'south', 'west'][i],
      );
      handle.title = 'Drag to resize area · arrow keys to adjust';
      const marker = new mapboxgl.Marker({ element: handle, draggable: true })
        .setLngLat(destination(stop.coords, stop.radius, i * 90).geometry.coordinates)
        .addTo(map);
      handle.setAttribute('role', 'button');
      areaHandles.push(marker);
      marker.on('dragstart', () => {
        rememberEdit();
        dragging = true;
      });
      marker.on('drag', () => {
        const c = marker.getLngLat();
        stop.radius = Math.max(0.05, distance(stop.coords, [c.lng, c.lat]));
        drawArea();
        areaHandles.forEach((m, j) => {
          if (i !== j)
            m.setLngLat(destination(stop.coords, stop.radius, j * 90).geometry.coordinates);
        });
      });
      marker.on('dragend', () => {
        dragging = false;
        updateSpatial(stop);
      });
      handle.onkeydown = (e) => {
        if (!['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        rememberEdit();
        stop.radius = Math.max(
          0.05,
          stop.radius + (['ArrowUp', 'ArrowRight'].includes(e.key) ? 0.1 : -0.1),
        );
        updateSpatial(stop);
        areaHandles[i].getElement().focus();
      };
    }
  }
  function drawMarkers() {
    const ids = new Set(stops.map((s) => s.id));
    for (const [id, marker] of markers)
      if (!ids.has(id)) {
        marker.remove();
        markers.delete(id);
      }
    for (const s of stops) {
      let marker = markers.get(s.id);
      if (!marker) {
        const id = s.id,
          button = document.createElement('button');
        button.className = 'stop-symbol';
        marker = new mapboxgl.Marker({ element: button }).setLngLat(s.coords).addTo(map);
        markers.set(id, marker);
        button.setAttribute('role', 'button');
        const current = () => stops.find((stop) => stop.id === id),
          editable = () => writable() && id === selected && !checked.size;
        button.onclick = (e) => {
          e.stopPropagation();
          if (!editable()) choose(id);
        };
        let previousCoords;
        marker.on('dragstart', () => {
          rememberEdit();
          dragging = true;
          previousCoords = [...current().coords];
        });
        marker.on('drag', () => {
          const c = marker.getLngLat(),
            stop = current();
          stop.coords = [c.lng, c.lat];
          drawArea();
          positionHandles(stop);
        });
        marker.on('dragend', () => {
          dragging = false;
          updateSpatial(current(), previousCoords);
        });
        button.onkeydown = (e) => {
          const bearing = { ArrowUp: 0, ArrowRight: 90, ArrowDown: 180, ArrowLeft: 270 }[e.key];
          if (!editable() || bearing === undefined) return;
          e.preventDefault();
          e.stopPropagation();
          rememberEdit();
          const stop = current(),
            previousCoords = [...stop.coords];
          stop.coords = destination(
            stop.coords,
            e.shiftKey ? 1 : 0.1,
            bearing,
          ).geometry.coordinates;
          updateSpatial(stop, previousCoords);
          button.focus();
        };
      }
      const editable = writable() && s.id === selected && !checked.size,
        button = marker.getElement();
      for (const [name, on] of Object.entries({
        past: temporal(s) === 'past',
        future: temporal(s) === 'future',
        selected: s.id === selected || checked.has(s.id),
        movable: editable,
      }))
        button.classList.toggle(name, on);
      const html = symbol(s) + (reported(s) ? '<span class="checklist-badge">✓</span>' : '');
      if (button.innerHTML !== html) button.innerHTML = html;
      button.setAttribute(
        'aria-label',
        s.name + ' · ' + s.type + ' · ' + temporal(s) + (editable ? ' · drag to move' : ''),
      );
      button.title = editable ? 'Drag to move stop · arrow keys to move 100 m' : s.name;
      marker.setDraggable(editable);
      const coords = marker.getLngLat();
      if (coords.lng !== s.coords[0] || coords.lat !== s.coords[1]) marker.setLngLat(s.coords);
    }
    drawHandles();
  }
  function closePopup() {
    popup?.remove();
    popup = null;
    popupPinned = false;
    hoverKey = '';
  }
  function mapFeatures(e) {
    return map.queryRenderedFeatures(e.point, {
      layers: ['report-pins', 'report-clusters', 'species', 'ebd'].filter(
        (id) => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none',
      ),
    });
  }
  function showPopup(feature, pinned) {
    const p = feature.properties,
      id = feature.layer.id;
    closePopup();
    popupPinned = pinned;
    hoverKey = id + ':' + (p.id || feature.geometry.coordinates.join(','));
    const box = document.createElement('div');
    box.className = 'location-popup';
    if (id === 'ebd')
      box.innerHTML =
        '<strong>' +
        escape(p.name) +
        '</strong><div>' +
        p.species +
        ' species · ' +
        p.count +
        ' checklists</div><span class="small">' +
        (p.hotspot ? 'Hotspot' : 'Personal location') +
        '</span>' +
        (pinned && p.hotspot
          ? '<a target="_blank" rel="noopener" href="https://ebird.org/hotspot/' +
            escape(p.id) +
            '">Open in eBird ↗</a>'
          : '');
    else if (id === 'report-pins')
      box.innerHTML =
        '<strong>' +
        escape(p.name) +
        '</strong><div>' +
        escape(p.date) +
        ' · ' +
        p.species +
        ' species</div>' +
        (pinned
          ? '<a target="_blank" rel="noopener" href="https://ebird.org/checklist/' +
            escape(p.id) +
            '">Open checklist ↗</a>'
          : '');
    else
      box.innerHTML =
        '<strong>' +
        escape(layer) +
        '</strong><div>' +
        Math.round(p.rate * 100) +
        '% reporting rate · ' +
        p.count +
        ' checklists</div>';
    popup = new mapboxgl.Popup({
      closeButton: pinned,
      closeOnClick: false,
      offset: 14,
      maxWidth: '260px',
      className: pinned ? 'pinned-popup' : 'hover-popup',
    })
      .setLngLat(feature.geometry.coordinates)
      .setDOMContent(box)
      .addTo(map);
    popup.on('close', () => {
      popupPinned = false;
      hoverKey = '';
    });
  }
  map.on('mousemove', (e) => {
    if (dragging) return;
    const f = mapFeatures(e)[0];
    map.getCanvas().style.cursor = f ? 'pointer' : '';
    if (popupPinned) return;
    if (!f || f.layer.id === 'report-clusters') {
      if (popup) closePopup();
      return;
    }
    if (hoverKey !== f.layer.id + ':' + (f.properties.id || f.geometry.coordinates.join(',')))
      showPopup(f, false);
  });
  map.getCanvas().addEventListener('mouseleave', () => {
    map.getCanvas().style.cursor = '';
    if (!popupPinned) closePopup();
  });
  map.on('movestart', () => {
    if (!popupPinned) closePopup();
  });
  map.on('click', async (e) => {
    const f = mapFeatures(e)[0];
    if (!f) {
      closePopup();
      return;
    }
    if (f.layer.id === 'report-clusters') {
      closePopup();
      const zoom = await map.getSource('report').getClusterExpansionZoom(f.properties.cluster_id);
      map.easeTo({ center: f.geometry.coordinates, zoom });
      return;
    }
    showPopup(f, true);
  });
  function setView(next) {
    view = next;
    if (next === 'species' && $('workspace-layout').classList.contains('mobile'))
      toggleSheet(false);
    $('map-view').setAttribute('aria-pressed', next === 'map');
    $('species-view').setAttribute('aria-pressed', next === 'species');
    $('map-panel').hidden = next !== 'map';
    $('species-panel').hidden = next !== 'species';
    renderSpecies();
    if (next === 'map') requestAnimationFrame(() => map.resize());
  }
  function choose(id, event = {}) {
    if (event.shiftKey && selected && writable()) {
      const a = stops.findIndex((s) => s.id === selected),
        b = stops.findIndex((s) => s.id === id);
      stops.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((s) => checked.add(s.id));
    } else if ((event.ctrlKey || event.metaKey) && writable()) {
      if (!checked.size && selected) checked.add(selected);
      checked.has(id) ? checked.delete(id) : checked.add(id);
    } else {
      if (selected !== id) {
        speciesSort = id ? 'rank' : 'avg';
        speciesDirection = id ? 1 : -1;
      }
      selected = id;
      checked.clear();
    }
    renderList();
    renderEditor();
    renderSpecies();
    drawMarkers();
    drawArea();
    $('stop-list')
      .querySelector('[data-stop="' + selected + '"]')
      ?.scrollIntoView({ block: 'nearest' });
    if (view === 'map') {
      if (active()) map.easeTo({ center: active().coords, zoom: 12, duration: 300 });
      else fitTrip();
    }
    if ($('workspace-layout').classList.contains('mobile') && !writable()) toggleSheet(false);
  }
  function renderList() {
    const list = $('stop-list'),
      scroll = list.scrollTop;
    root.querySelector('.itinerary').append($('editor'));
    $('single-edit').prepend($('inline-name-row'));
    list.innerHTML = '';
    $('full-trip').setAttribute('aria-pressed', !selected);
    for (const day of [...new Set(stops.map((s) => s.date.slice(0, 10)))].sort()) {
      const group = stops.filter((s) => s.date.startsWith(day));
      const birding = group
          .filter((s) => s.type === 'Birding')
          .reduce((sum, s) => sum + s.duration, 0),
        legs = group.map((s) => routes.get(s.id)).filter(Boolean);
      const reportCount = reportChecklists().filter((c) => c.date.startsWith(day)).length;
      const section = document.createElement('section');
      section.className = 'day-group';
      section.setAttribute('aria-label', dayFormatter.format(new Date(day + 'T12:00')));
      const head = document.createElement('header');
      head.className = 'day';
      head.innerHTML =
        '<strong>' +
        dayFormatter.format(new Date(day + 'T12:00')) +
        '</strong><span>' +
        group.length +
        (group.length === 1 ? ' stop' : ' stops') +
        (writable()
          ? ' · ' +
            Number(birding.toFixed(1)) +
            'h birding · ' +
            driveLabel(legs.reduce((sum, r) => sum + r.duration, 0)) +
            ' driving'
          : reportCount
            ? ' · ' + reportCount + ' checklists'
            : '') +
        '</span>';
      section.append(head);
      list.append(section);
      for (const s of group) {
        const row = document.createElement('div'),
          r = routes.get(s.id);
        row.dataset.stop = s.id;
        row.className = 'stop-row' + (s.id === selected || checked.has(s.id) ? ' active' : '');
        row.innerHTML =
          '<button class="stop-button" aria-pressed="' +
          (s.id === selected || checked.has(s.id)) +
          '"><time>' +
          timeLabel(s.date) +
          '</time><span class="stop-symbol ' +
          temporal(s) +
          (s.id === selected ? ' selected' : '') +
          '">' +
          symbol(s) +
          (reported(s)
            ? '<span class="checklist-badge" aria-label="Report checklist in area">✓</span>'
            : '') +
          '</span><span class="stop-text"><strong>' +
          escape(s.name) +
          '</strong></span></button>' +
          (stops.indexOf(s) > 0
            ? '<button class="leg edit-only ' +
              (r ? 'computed' : '') +
              '" title="' +
              (r
                ? Math.round(r.distance / 1000) + ' km · click to recompute'
                : 'Compute drive from previous stop') +
              '" aria-label="' +
              (r ? 'Recompute' : 'Compute') +
              ' drive to ' +
              escape(s.name) +
              '">' +
              (r ? '↳ ' + driveLabel(r.duration) : '↳ Drive') +
              '</button>'
            : '');
        const button = row.querySelector('.stop-button');
        let timer,
          held = false;
        button.onclick = (e) => {
          if (!held) choose(s.id, e);
          held = false;
        };
        button.onpointerdown = (e) => {
          if (e.pointerType === 'touch' && writable())
            timer = setTimeout(() => {
              held = true;
              choose(s.id, { ctrlKey: true });
            }, 550);
        };
        button.onpointerup =
          button.onpointercancel =
          button.onpointermove =
            () => clearTimeout(timer);
        row.querySelector('.leg')?.addEventListener('click', () => computeRoute(s));
        if (s.id === selected && writable() && !checked.size) {
          row.classList.add('inline-edit-row');
          button.querySelector('.stop-symbol').remove();
          button.querySelector('.stop-text').remove();
          button.setAttribute('aria-label', 'Select ' + s.name);
          row.insertBefore($('inline-name-row'), row.querySelector('.leg'));
        }
        section.append(row);
        if (s.id === selected && writable() && !checked.size) section.append($('editor'));
      }
    }
    if (!checked.size && !list.contains($('editor'))) $('editor').hidden = true;
    list.scrollTop = scroll;
    $('sheet-title').textContent = 'Itinerary';
  }
  function renderEditor() {
    const s = active(),
      bulk = checked.size > 0;
    $('visitor-details').innerHTML =
      !writable() && s
        ? '<strong>' +
          escape(s.name) +
          '</strong><p>' +
          escape(s.note) +
          '</p>' +
          (s.type === 'Birding' && s.targets.length
            ? '<span class="target-star">★</span> ' + s.targets.map(escape).join(', ')
            : '')
        : '';
    $('editor').hidden = !s && !bulk;
    $('detail-split').hidden = !s && !bulk;
    renderSelectionStats();
    $('single-edit').hidden = bulk;
    $('bulk-edit').hidden = !bulk;
    $('bulk-title').textContent = checked.size + ' stops selected';
    if (!s || bulk) {
      root.querySelector('.itinerary').append($('selection-stats'));
      lastDetailStop = 0;
      applyStopDisplay();
      return;
    }
    if (lastDetailStop !== s.id) {
      $('stop-extra-details').open = false;
      $('interest-details').open = true;
      lastDetailStop = s.id;
    }
    $('interest-label').textContent = s.targets.length
      ? 'Species of interest'
      : 'Add species of interest';
    for (const [id, value] of Object.entries({
      name: s.name,
      type: s.type,
      datetime: s.date,
      duration: s.duration,
      note: s.note,
    }))
      $(id).value = value;
    if (writable()) $('stop-extra-body').append($('selection-stats'), $('remove'));
    else root.querySelector('.itinerary').append($('selection-stats'));
    $('type-icon').className = 'bi bi-' + icons[s.type];
    $('duration').disabled = $('target-search').disabled = s.type !== 'Birding';
    $('target-search').value = '';
    $('target-options').hidden = true;
    $('target-search').setAttribute('aria-expanded', 'false');
    renderTargets();
    applyStopDisplay();
  }
  function renderTargets() {
    const s = active();
    if (!s) return;
    $('target-chips').innerHTML = s.targets
      .map(
        (name) =>
          '<button data-remove="' +
          escape(name) +
          '" aria-label="Remove ' +
          escape(name) +
          ' from species of interest">' +
          '<i class="bi bi-star-fill target-star"></i> ' +
          escape(name) +
          ' ×</button>',
      )
      .join('');
    $('target-chips')
      .querySelectorAll('button')
      .forEach(
        (b) =>
          (b.onclick = () => {
            change(
              'targets',
              s.targets.filter((n) => n !== b.dataset.remove),
            );
            renderTargets();
          }),
      );
    const query = $('target-search').value.toLowerCase();
    $('target-options').innerHTML = data.taxa
      .filter((t) => t.name.toLowerCase().includes(query) && !s.targets.includes(t.name))
      .slice(0, 20)
      .map(
        (t) =>
          '<button role="option" aria-selected="false" data-target="' +
          escape(t.name) +
          '">' +
          escape(t.name) +
          '</button>',
      )
      .join('');
    $('target-options')
      .querySelectorAll('button')
      .forEach(
        (b) =>
          (b.onclick = () => {
            change('targets', [...s.targets, b.dataset.target]);
            $('target-search').value = '';
            renderTargets();
            $('target-search').focus();
          }),
      );
  }
  // Match the original Species List model: rates per visit, effort-adjusted trip probability, and rank.
  function planningSpecies() {
    const key = selected + ':' + reportKey;
    if (planningCache && planningKey === key) return planningCache;
    planningKey = key;
    const visits = stops.filter((s) => s.type === 'Birding' && s.historicalCount > 0),
      stop = active(),
      seenCodes = new Set(
        stage() === 'after' && synced
          ? data.reportTaxa.map((t) => t.speciesCode)
          : aggregation().counts.keys(),
      );
    planningCache = [...taxa.values()]
      .filter((t) => t.ebd)
      .map((t) => {
        const rates = visits.map((s) => (s.historicalSpecies[t.code] || 0) / s.historicalCount),
          location =
            stop?.type === 'Birding'
              ? (stop.historicalSpecies[t.code] || 0) / (stop.historicalCount || 1)
              : 0;
        const cumulative =
            1 -
            visits.reduce(
              (miss, s, i) => miss * Math.pow(1 - Math.min(1, rates[i]), s.duration || 1),
              1,
            ),
          avg = rates.reduce((a, b) => a + b, 0) / (rates.length || 1);
        const seen = seenCodes.has(t.code),
          interest = (stop ? [stop] : stops).some((s) => s.targets.includes(t.name));
        return {
          ...t,
          location,
          avg,
          cumulative,
          overall: (globalEbdCounts.get(t.code) || 0) / (globalEbdTotal || 1),
          rank: 1 + rates.filter((rate) => rate > location).length,
          seen,
          interest,
          newLife: t.life === true && !seen,
          newRegion: t.region === true && !seen,
        };
      });
    return planningCache;
  }
  const percent = (value) => (100 * value).toFixed(1) + '%';
  function renderSpecies() {
    if (view !== 'species') return;
    const stop = active(),
      a = aggregation(stop),
      recorded = !writable(),
      planned = recorded && (!synced || stage() === 'before');
    $('species-panel').classList.toggle('planning', !recorded);
    $('species-filters').hidden = recorded;
    $('expected-summary').hidden = recorded;
    if (recorded) {
      let codes = planned
        ? data.taxa
            .filter((t) => (stop ? [stop] : stops).some((s) => s.targets.includes(t.name)))
            .map((t) => t.code)
        : [...a.counts.keys()];
      if (!planned && !stop && stage() === 'after' && synced)
        codes = [...new Set([...codes, ...data.reportTaxa.map((t) => t.speciesCode)])];
      const items = codes
        .map((code) => taxa.get(code))
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
      $('species-columns').innerHTML =
        '<tr><th>Species</th><th>' + (planned ? 'Interest' : 'Individuals / lists') + '</th></tr>';
      $('species-rows').innerHTML = items
        .map((t) => {
          const v = a.counts.get(t.code),
            total =
              !stop && stage() === 'after'
                ? data.reportTaxa.find((r) => r.speciesCode === t.code)
                : null;
          return (
            '<tr><td><strong>' +
            escape(t.name) +
            '</strong><span class="latin"> ' +
            escape(t.latin) +
            '</span></td><td>' +
            (planned
              ? '<i class="bi bi-star-fill target-star"></i>'
              : total
                ? (total.numIndividuals || 'uncounted') + ' / ' + total.numChecklists
                : v
                  ? (v.unknown ? '≥' : '') + v.individuals + ' / ' + v.checklists
                  : '—') +
            '</td></tr>'
          );
        })
        .join('');
      $('species-evidence').textContent =
        items.length +
        ' taxa' +
        (planned
          ? ' · planned targets'
          : ' · ' +
            a.lists.length +
            ' checklists' +
            (a.missing ? ' · incomplete species details' : ''));
      $('report-status').textContent = planned
        ? ''
        : 'Individuals are summed across checklists, not unique birds.';
      return;
    }
    const all = planningSpecies(),
      maximum = Number($('max-trip').value),
      minimum = Number($('min-rate').value);
    $('min-rate-name').textContent = stop ? 'Location (min)' : 'Average trip (min)';
    $('max-trip-label').textContent = Math.round(maximum * 100) + '%';
    $('min-rate-label').textContent = Math.round(minimum * 100) + '%';
    // Only offer the filters that can match something here; hidden ones are cleared.
    const usable = {
      life: [...taxa.values()].some((t) => t.life !== null),
      region: [...taxa.values()].some((t) => t.region !== null),
      trip: synced,
      interest: Boolean(stop),
    };
    for (const [id, show] of Object.entries(usable)) {
      $('filter-' + id).closest('label').hidden = !show;
      if (!show) $('filter-' + id).checked = false;
    }
    const filters = Object.keys(usable).filter((id) => $('filter-' + id).checked);
    const filtered = all.filter(
      (t) =>
        (!stop || t.location > 0) &&
        (stop ? t.location : t.avg) >= minimum &&
        t.cumulative <= maximum &&
        (!filters.length ||
          filters.some((f) =>
            f === 'life'
              ? t.newLife
              : f === 'region'
                ? t.newRegion
                : f === 'trip'
                  ? !t.seen
                  : t.interest,
          )),
    );
    const sort = speciesSort === 'rank' && !stop ? 'avg' : speciesSort;
    filtered.sort(
      (a, b) =>
        speciesDirection *
          (sort === 'name'
            ? a.name.localeCompare(b.name)
            : sort === 'taxon'
              ? a.order - b.order
              : (a[sort] ?? 0) - (b[sort] ?? 0)) || a.name.localeCompare(b.name),
    );
    const columns = [
      ['taxon', 'Tax.'],
      ...(stop ? [['interest', '★']] : []),
      ['name', 'Species'],
      ...(stop ? [['rank', 'Top']] : []),
      [stop ? 'location' : 'avg', stop ? 'Location' : 'Avg. Trip'],
      ['cumulative', 'Cum. Trip'],
      ...(!stop ? [['overall', 'EBD']] : []),
    ];
    $('species-columns').innerHTML =
      '<tr>' +
      columns
        .map(
          ([key, label]) =>
            '<th><button data-sort="' +
            key +
            '" title="' +
            (key === 'rank'
              ? 'Rank among planned stops'
              : key === 'cumulative'
                ? 'Effort-adjusted probability across planned visits'
                : label) +
            '">' +
            label +
            (sort === key ? (speciesDirection === 1 ? ' ↑' : ' ↓') : '') +
            '</button></th>',
        )
        .join('') +
      '</tr>';
    $('species-columns')
      .querySelectorAll('button')
      .forEach(
        (b) =>
          (b.onclick = () => {
            if (speciesSort === b.dataset.sort) speciesDirection *= -1;
            else {
              speciesSort = b.dataset.sort;
              speciesDirection = ['name', 'taxon', 'rank'].includes(speciesSort) ? 1 : -1;
            }
            renderSpecies();
          }),
      );
    $('species-rows').innerHTML =
      filtered
        .map(
          (t, i) =>
            '<tr class="' +
            (t.interest ? 'interest-row' : '') +
            '"><td class="taxon-cell">' +
            (i + 1) +
            '</td>' +
            (stop
              ? '<td><button class="interest-toggle" aria-label="Toggle interest for ' +
                escape(t.name) +
                '" aria-pressed="' +
                t.interest +
                '" data-interest="' +
                t.code +
                '"><i class="bi bi-star' +
                (t.interest ? '-fill target-star' : '') +
                '"></i></button></td>'
              : '') +
            '<td><button class="species-name" data-map="' +
            t.code +
            '">' +
            escape(t.name) +
            '</button><span class="latin"> ' +
            escape(t.latin) +
            '</span> ' +
            (t.newLife
              ? '<i class="bi bi-globe2 lifer-icon" title="Life target"></i>'
              : t.newRegion
                ? '<i class="bi bi-geo-alt-fill lifer-icon" title="Region target"></i>'
                : synced && !t.seen
                  ? '<i class="bi bi-car-front-fill lifer-icon" title="Not yet on trip report"></i>'
                  : '') +
            '</td>' +
            (stop ? '<td>' + t.rank + '</td>' : '') +
            '<td>' +
            percent(stop ? t.location : t.avg) +
            '</td><td>' +
            percent(t.cumulative) +
            '</td>' +
            (!stop ? '<td>' + percent(t.overall) + '</td>' : '') +
            '</tr>',
        )
        .join('') || '<tr><td colspan="7">No species match these filters.</td></tr>';
    $('species-rows')
      .querySelectorAll('[data-interest]')
      .forEach(
        (b) =>
          (b.onclick = () => {
            const t = taxa.get(b.dataset.interest);
            change(
              'targets',
              active().targets.includes(t.name)
                ? active().targets.filter((n) => n !== t.name)
                : [...active().targets, t.name],
            );
            renderTargets();
          }),
      );
    $('species-rows')
      .querySelectorAll('[data-map]')
      .forEach(
        (b) =>
          (b.onclick = () => {
            layer = taxa.get(b.dataset.map).name;
            $('cluster-species').value = layer;
            setView('map');
            $('cluster-dialog').showModal();
          }),
      );
    const expected = (predicate) =>
        all
          .filter(predicate)
          .reduce((sum, t) => sum + (stop ? t.location : t.cumulative), 0)
          .toFixed(1),
      hasLife = [...taxa.values()].some((t) => t.life !== null),
      hasRegion = [...taxa.values()].some((t) => t.region !== null);
    const stat = (icon, label, value) =>
      '<span class="expected-stat">' +
      (icon ? '<i class="bi bi-' + icon + ' lifer-icon" aria-hidden="true"></i> ' : '') +
      label +
      ' <b>' +
      value +
      '</b></span>';
    $('expected-summary').innerHTML =
      '<span class="expected-line" title="Expected number of species: sum of ' +
      (stop ? 'location rates' : 'trip probabilities') +
      ' across all taxa, before table filters">' +
      '<strong>Expected species</strong>' +
      stat(
        '',
        'Total',
        expected(() => true),
      ) +
      (hasLife
        ? stat(
            'globe2',
            'Life',
            expected((t) => t.newLife),
          )
        : '') +
      (hasRegion
        ? stat(
            'geo-alt-fill',
            'Region',
            expected((t) => t.newRegion),
          )
        : '') +
      (synced && stop
        ? stat(
            'car-front-fill',
            'Trip',
            expected((t) => !t.seen),
          )
        : '') +
      '</span>';
    const exportButton = document.createElement('button');
    exportButton.textContent = 'Export CSV';
    exportButton.className = 'species-export';
    exportButton.onclick = () => {
      const quote = (v) => '"' + String(v ?? '').replaceAll('"', '""') + '"',
        rows = [
          [
            'code',
            'commonName',
            'scientificName',
            'liferWorld',
            'liferRegion',
            'tripReportSeen',
            'targetInterest',
            'locationRank',
            'locationRate',
            'totalProbability',
            'avgRate',
            'overallRate',
          ],
          ...filtered.map((t) => [
            t.code,
            t.name,
            t.latin,
            t.life,
            t.region,
            t.seen,
            t.interest,
            stop ? t.rank : '',
            stop ? t.location : '',
            t.cumulative,
            t.avg,
            t.overall,
          ]),
        ],
        blob = new Blob([rows.map((row) => row.map(quote).join(',')).join('\n')], {
          type: 'text/csv;charset=utf-8',
        }),
        url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = 'trip-species.csv';
      a.click();
      URL.revokeObjectURL(url);
    };
    $('expected-summary').append(exportButton);
    $('species-evidence').textContent = filtered.length + ' / ' + all.length + ' taxa';
    $('report-status').textContent = '';
  }
  function renderJourney() {
    const a = aggregation(),
      uniqueLocations = new Set(a.lists.map((c) => c.locId)).size;
    const codes =
      stage() === 'after' && synced
        ? data.reportTaxa.filter((t) => t.category === 'species').map((t) => t.speciesCode)
        : [...a.counts.keys()].filter((code) => taxa.get(code)?.category === 'species');
    $('journey-stage').textContent = {
      before: 'Before the trip',
      during: 'During the trip',
      after: 'After the trip',
    }[stage()];
    $('journey-dates').textContent = ' · ' + dateLabel(data.start) + '–' + dateLabel(data.end);
    $('journey-results').textContent =
      stage() === 'before'
        ? stops.length + ' planned stops'
        : (stage() === 'during' && a.missing ? '≥' : '') +
          codes.length +
          ' species · ' +
          a.lists.length +
          ' checklists · ' +
          uniqueLocations +
          ' locations';
    $('sync-label').textContent =
      'Snapshot: ' +
      dateLabel(cutoff()) +
      ' · ' +
      (stage() === 'before' ? 'plan only' : 'real report data');
    $('report-open').href = 'https://ebird.org/tripreport/' + (reportId || data.reportId);
    $('report-open').hidden = writable() || !reportId;
    $('report-layer-status').textContent =
      a.lists.length + ' report checklists · nearby pins clustered';
    $('report-layer').disabled = !a.lists.length;
    renderReportSummary();
  }
  function renderAccess() {
    $('settings-dialog')
      .querySelectorAll('.edit-only')
      .forEach((el) => (el.hidden = !writable()));
    for (const el of [$('workspace-layout')]) {
      el.classList.toggle('visitor', options.visitor);
      el.classList.toggle('invited', options.invited);
      el.classList.toggle('preview', !writable());
    }
    $('mode').textContent = preview ? 'Edit trip' : 'Preview';
    $('hotspots').checked = $('personal-locations').checked = writable();
    $('species-layer').checked = false;
    $('report-layer').checked = true;
    if (!writable()) $('layers').open = false;
    renderJourney();
    renderSpecies();
    drawMarkers();
    drawLayers();
    requestAnimationFrame(() => map.resize());
  }
  function renderReportSummary() {
    $('report-link').value = reportId ? 'https://ebird.org/tripreport/' + reportId : '';
    $('report-summary').textContent = reportId
      ? synced
        ? aggregation().lists.length + ' checklists loaded through ' + dateLabel(cutoff())
        : 'No checklists loaded'
      : 'Add a trip report link to load checklists';
    $('disconnect-report').hidden = !reportId;
  }
  function queueSave() {
    if (!writable()) return;
    options
      .onSave(workspaceModelPlan(options.getPlan(), stops, routes, reportId, taxa))
      .catch((error) => feedback(error.message));
  }
  function change(field, value) {
    planningCache = null;
    if (!writable() || !active()) return;
    rememberEdit(['name', 'note', 'duration'].includes(field) ? selected + ':' + field : '');
    active()[field] = value;
    if (field === 'targets') {
      $('interest-label').textContent = value.length
        ? 'Species of interest'
        : 'Add species of interest';
      if (value.length) $('interest-details').open = true;
    }
    if (field === 'note') {
      queueSave();
      return;
    }
    if (field === 'type') {
      updateSpatial(active());
      return;
    }
    if (field === 'date') {
      stops.sort((a, b) => a.date.localeCompare(b.date));
      routes.clear();
      drawLayers();
      drawMarkers();
    }
    if (field === 'date' || field === 'duration') renderList();
    if (field === 'name')
      markers
        .get(selected)
        ?.getElement()
        .setAttribute('aria-label', value + ' · ' + active().type + ' · ' + temporal(active()));
    renderSpecies();
    queueSave();
  }
  function toggleSheet(open) {
    $('workspace-layout').classList.toggle('sheet-open', open);
    $('sheet').textContent = open ? 'Collapse ↓' : 'Open itinerary ↑';
    $('sheet').setAttribute('aria-expanded', open);
    $('sheet').setAttribute('aria-label', open ? 'Collapse itinerary' : 'Open itinerary');
  }
  async function computeRoute(stop) {
    if (!writable()) return;
    rememberEdit();
    const index = stops.indexOf(stop),
      from = stops[index - 1],
      coordinates = JSON.stringify([from.coords, stop.coords]);
    feedback('Computing road route…');
    try {
      const r = await fetch(
        'https://api.mapbox.com/directions/v5/mapbox/driving/' +
          from.coords.join(',') +
          ';' +
          stop.coords.join(',') +
          '?overview=full&geometries=polyline6&access_token=' +
          mapboxgl.accessToken,
      );
      const data = await r.json();
      if (!data.routes?.length) throw Error('Route unavailable');
      if (
        disposed ||
        !stops.includes(stop) ||
        stops[stops.indexOf(stop) - 1] !== from ||
        coordinates !== JSON.stringify([from.coords, stop.coords])
      )
        return;
      routes.set(stop.id, {
        ...data.routes[0],
        geometry: compactRouteGeometry(polyline.toGeoJSON(data.routes[0].geometry, 6)),
      });
      drawLayers();
      renderList();
      queueSave();
      feedback('');
    } catch (error) {
      feedback(error.message);
    }
  }
  function removeStops(ids) {
    rememberEdit();
    planningCache = null;
    selectionStatsKey = '';
    stops = stops.filter((s) => !ids.includes(s.id));
    routes.clear();
    selected = stops[0]?.id || 0;
    checked.clear();
    renderList();
    renderEditor();
    renderSpecies();
    drawMarkers();
    drawLayers();
    queueSave();
    feedback('Stops removed · Undo available');
  }

  const selectionAreas = () =>
    checked.size
      ? stops.filter((s) => checked.has(s.id) && s.type === 'Birding')
      : active()
        ? active().type === 'Birding'
          ? [active()]
          : []
        : stops.filter((s) => s.type === 'Birding');
  function selectedLocations() {
    return [...new Set(selectionAreas().flatMap((s) => stopLocations.get(s.id) || []))];
  }
  const median = (values) => {
    values.sort((a, b) => a - b);
    return values.length
      ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2
      : null;
  };
  let commentEntries = [],
    commentLocations = new Map();
  const commentsByLocation = new Map();
  for (const c of data.comments) {
    if (!commentsByLocation.has(c.locality_id)) commentsByLocation.set(c.locality_id, []);
    commentsByLocation.get(c.locality_id).push(c);
  }
  function renderSelectionStats() {
    reportChecklists();
    const key = JSON.stringify([selected, [...checked], writable(), reportKey]);
    if (selectionStatsKey === key) return;
    selectionStatsKey = key;
    const locations = selectedLocations(),
      species = new Set(locations.flatMap((l) => Object.keys(l.counts))),
      minutes = median(locations.flatMap((l) => l.durations)),
      km = median(locations.flatMap((l) => l.distances));
    commentEntries = locations.flatMap((l) => commentsByLocation.get(l.id) || []);
    commentLocations = new Map(
      locations.map((l) => [
        l.id,
        { locality: l.name, latitude: l.coords[1], longitude: l.coords[0] },
      ]),
    );
    const areas = selectionAreas(),
      lists = reportChecklists().filter(
        (c) => (!selected && !checked.size) || areas.some((s) => memberships.get(s.id)?.has(c.id)),
      ),
      seen = new Set(
        lists
          .flatMap((c) => Object.keys(c.species))
          .filter((code) => taxa.get(code)?.category === 'species'),
      );
    $('historical-stats').innerHTML = writable()
      ? '<div class="stats-label">Historical EBD selection</div><div class="stats-grid"><span><b>' +
        (minutes === null ? '—' : Math.round(minutes) + ' min') +
        '</b> median duration</span><span><b>' +
        (km === null ? '—' : km.toFixed(1) + ' km') +
        '</b> median distance</span></div><div class="stats-grid stats-secondary"><span>' +
        species.size +
        ' species</span><span>' +
        locations.reduce((n, l) => n + l.totalCount, 0).toLocaleString() +
        ' checklists</span><span>' +
        locations.length +
        ' locations</span></div>'
      : '';
    $('recorded-stats').innerHTML = lists.length
      ? '<div class="recorded-stats"><strong>Trip report</strong><span>' +
        lists.length +
        ' checklists · ' +
        (lists.every((c) => !Object.keys(c.species).length)
          ? 'species details not loaded'
          : seen.size +
            ' species seen' +
            (lists.some((c) => !Object.keys(c.species).length)
              ? ' · partial species details'
              : '')) +
        '</span></div>'
      : '';
    $('selection-stats').hidden = !writable() && !lists.length;
    $('comment-feedback').textContent = '';
    $('copy-comments').disabled = $('download-comments').disabled = !commentEntries.length;
  }
  function commentsMarkdown() {
    return buildCommentMarkdown({
      heading:
        (checked.size ? checked.size + ' selected stops' : active()?.name || 'Entire trip') +
        ' — observer comments',
      entries: commentEntries,
      locationsById: commentLocations,
      speciesNameByCode: new Map(data.taxa.map((t) => [t.code, t.name])),
    });
  }
  $('copy-comments').onclick = async () => {
    $('comment-feedback').textContent = (await copyMarkdown(commentsMarkdown()))
      ? 'Copied'
      : 'Copy unavailable';
  };
  $('download-comments').onclick = () => {
    downloadMarkdown('trip-observer-comments.md', commentsMarkdown());
    $('comment-feedback').textContent = 'Downloaded';
  };
  $('full-trip').onclick = () => choose(0);
  // Resize either the itinerary/details split or the sidebar/map split.
  for (const [id, horizontal] of [
    ['detail-split', true],
    ['map-split', false],
  ]) {
    const separator = $(id);
    separator.onpointerdown = (e) => {
      e.preventDefault();
      separator.setPointerCapture(e.pointerId);
    };
    separator.onpointermove = (e) => {
      if (!separator.hasPointerCapture(e.pointerId)) return;
      if (horizontal) {
        const top = $('stop-list').getBoundingClientRect().top,
          bottom = $('selection-stats').getBoundingClientRect().top;
        const height = Math.max(85, Math.min(e.clientY - top, bottom - top - 200));
        root.querySelector('.itinerary').style.setProperty('--list-height', height + 'px');
      } else
        $('workspace-layout').style.setProperty(
          '--sidebar-width',
          Math.max(310, Math.min(e.clientX, 650)) + 'px',
        );
    };
    separator.onkeydown = (e) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      const increase = ['ArrowDown', 'ArrowRight'].includes(e.key);
      if (horizontal)
        root
          .querySelector('.itinerary')
          .style.setProperty(
            '--list-height',
            Math.max(85, $('stop-list').clientHeight + (increase ? 25 : -25)) + 'px',
          );
      else
        $('workspace-layout').style.setProperty(
          '--sidebar-width',
          Math.max(
            310,
            Math.min(root.querySelector('.itinerary').clientWidth + (increase ? 25 : -25), 650),
          ) + 'px',
        );
    };
  }

  for (const id of [
    'filter-life',
    'filter-region',
    'filter-trip',
    'filter-interest',
    'max-trip',
    'min-rate',
  ])
    $(id).oninput = renderSpecies;
  function renderLists() {
    for (const kind of ['life', 'region']) {
      const values = [...taxa.values()].filter((t) => t[kind] !== null);
      $(kind + '-list-status').textContent = values.length
        ? values.filter((t) => t[kind] === false).length + ' species matched'
        : 'No list imported';
      $(kind + '-clear').disabled = !values.length;
    }
  }
  for (const kind of ['life', 'region']) {
    $(kind + '-upload').onchange = async (e) => {
      const file = e.target.files[0],
        parsed = Papa.parse(await file.text(), { header: true, skipEmptyLines: true }),
        names = new Set();
      for (const row of parsed.data) {
        if (!isCountableTaxon(row)) continue;
        const taxon = resolveSpeciesTaxon(extractTaxonFields(row));
        if (taxon) names.add(taxon.sciName);
      }
      if (!names.size) {
        $('list-feedback').textContent =
          'No matching taxa found. Use an eBird life or region CSV export.';
        return;
      }
      planningCache = null;
      for (const t of taxa.values()) t[kind] = !names.has(t.latin);
      await options.onLists(kind, taxa);
      $('list-feedback').textContent = file.name + ' loaded for ' + kind + ' targets.';
      $('filter-' + kind).checked = false;
      renderLists();
      renderSpecies();
    };
    $(kind + '-clear').onclick = async () => {
      planningCache = null;
      for (const t of taxa.values()) t[kind] = null;
      await options.onLists(kind, taxa);
      $(kind + '-upload').value = '';
      $('filter-' + kind).checked = false;
      renderLists();
      renderSpecies();
    };
  }
  $('map-view').onclick = () => setView('map');
  $('species-view').onclick = () => setView('species');
  $('mode').onclick = () => {
    preview = !preview;
    checked.clear();
    renderAccess();
    renderList();
    renderEditor();
  };
  $('sheet').onclick = () => toggleSheet(!$('workspace-layout').classList.contains('sheet-open'));
  $('name').oninput = (e) => change('name', e.target.value);
  $('type').onchange = (e) => {
    change('type', e.target.value);
    renderEditor();
  };
  $('datetime').onchange = (e) => change('date', e.target.value);
  $('duration').oninput = (e) => change('duration', Number(e.target.value));
  $('note').oninput = (e) => change('note', e.target.value);
  $('auto-name').onclick = () => {
    if (!data.ebdLocations.length) return;
    change(
      'name',
      data.ebdLocations.reduce((a, b) =>
        distance(active().coords, a.coords) < distance(active().coords, b.coords) ? a : b,
      ).name,
    );
    $('name').value = active().name;
  };
  $('target-search').oninput = () => {
    renderTargets();
    $('target-options').hidden = false;
    $('target-search').setAttribute('aria-expanded', 'true');
  };
  $('target-search').onkeydown = (e) => {
    if (e.key === 'Escape') {
      $('target-options').hidden = true;
      $('target-search').setAttribute('aria-expanded', 'false');
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      $('target-options').querySelector('button')?.click();
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      $('target-options').querySelector('button')?.focus();
    }
  };
  $('shift').onclick = () => {
    rememberEdit();
    const amount = Number($('shift-amount').value),
      unit = $('shift-unit').value;
    for (const s of stops.filter((s) => checked.has(s.id))) {
      const d = new Date(s.date);
      if (unit === 'hours') d.setHours(d.getHours() + amount);
      else d.setDate(d.getDate() + amount * (unit === 'weeks' ? 7 : 1));
      s.date =
        d.getFullYear() +
        '-' +
        String(d.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(d.getDate()).padStart(2, '0') +
        'T' +
        String(d.getHours()).padStart(2, '0') +
        ':' +
        String(d.getMinutes()).padStart(2, '0');
    }
    stops.sort((a, b) => a.date.localeCompare(b.date));
    routes.clear();
    renderList();
    drawLayers();
    drawMarkers();
    queueSave();
    feedback(checked.size + ' stops shifted');
  };
  $('remove').onclick = () => removeStops([selected]);
  $('remove-bulk').onclick = () => removeStops([...checked]);
  $('add').onclick = () => {
    rememberEdit();
    const id = crypto.randomUUID(),
      date = active()?.date || data.start + 'T07:00',
      c = map.getCenter();
    stops.push({
      id,
      name: 'New birding stop',
      date,
      type: 'Birding',
      duration: 1,
      radius: 1,
      coords: [c.lng, c.lat],
      targets: [],
      note: '',
      historicalCount: 0,
      historicalSpecies: {},
    });
    memberships.set(
      id,
      new Set(
        data.reportChecklists
          .filter((x) => distance([c.lng, c.lat], x.coords) <= 1)
          .map((x) => x.id),
      ),
    );
    stops.sort((a, b) => a.date.localeCompare(b.date));
    choose(id);
    updateSpatial(active());
  };
  $('fit').onclick = fitTrip;
  function updateBasemapCards() {
    for (const [id, style] of [
      ['map', preferences.mapStyle],
      ['satellite', 'satellite-streets-v12'],
    ])
      $('basemap-' + id + '-image').src =
        'https://api.mapbox.com/styles/v1/mapbox/' +
        style +
        '/static/9.83,46.58,10/240x100@2x?access_token=' +
        mapboxgl.accessToken;
  }
  updateBasemapCards();
  for (const id of ['map', 'satellite'])
    $('basemap-' + id).onclick = () => {
      if (basemap === (id === 'map' ? 'outdoor' : 'satellite')) return;
      basemap = id === 'map' ? 'outdoor' : 'satellite';
      $('basemap-map').setAttribute('aria-pressed', id === 'map');
      $('basemap-satellite').setAttribute('aria-pressed', id === 'satellite');
      map.setStyle(
        'mapbox://styles/mapbox/' + (id === 'map' ? preferences.mapStyle : 'satellite-streets-v12'),
      );
    };
  $('settings-open').onclick = () => {
    renderLists();
    renderReportSummary();
    $('settings-dialog').showModal();
  };
  $('settings-close').onclick = () => $('settings-dialog').close();
  $('map-style').value = preferences.mapStyle;
  $('map-style').onchange = (e) => {
    preferences.mapStyle = e.target.value;
    savePreferences();
    updateBasemapCards();
    if (basemap === 'outdoor') map.setStyle('mapbox://styles/mapbox/' + preferences.mapStyle);
  };
  function applyStopDisplay() {
    const inline = writable() && active() && !checked.size;
    for (const [id, mode] of Object.entries(preferences.fields)) {
      const field = $(id);
      field.hidden =
        (writable() && mode === 'hidden') ||
        (active() &&
          active().type !== 'Birding' &&
          !['datetime-field', 'note-details'].includes(id));
      if (id === 'datetime-field' || id === 'duration-field')
        $(mode === 'detail' ? 'detail-timing' : 'default-timing').append(field);
      else if (inline)
        $(mode === 'default' ? 'stop-default-body' : 'stop-extra-body').append(field);
      else if (['historical-stats', 'recorded-stats'].includes(id)) $('stop-stats').append(field);
      else if (id === 'comments-panel') $('selection-stats').append(field);
      else $('stop-extra-body').append(field);
      if (id === 'interest-details' && mode === 'default') field.open = true;
    }
    $('selection-stats').hidden =
      inline ||
      (active() && active().type !== 'Birding') ||
      (!writable() && !aggregation(active()).lists.length);
    if (active() && active().type !== 'Birding') {
      $('datetime-field').hidden = false;
      $('default-timing').append($('datetime-field'));
      $('stop-default-body').append($('note-details'));
      $('note-details').hidden = false;
    }
    // Removing a stop is always accessible, even when every optional field is hidden.
    $('stop-extra-body').append($('remove'));
  }
  for (const id of Object.keys(displayDefaults)) {
    $('display-' + id).value = preferences.fields[id];
    $('display-' + id).onchange = (e) => {
      preferences.fields[id] = e.target.value;
      savePreferences();
      applyStopDisplay();
    };
  }
  $('reset-display').onclick = () => {
    preferences.fields = { ...displayDefaults };
    savePreferences();
    for (const id of Object.keys(displayDefaults))
      $('display-' + id).value = preferences.fields[id];
    applyStopDisplay();
  };
  $('key-open').onclick = () => $('key-dialog').showModal();
  $('key-close').onclick = () => $('key-dialog').close();
  $('hotspots').onchange =
    $('personal-locations').onchange =
    $('report-layer').onchange =
      () => {
        drawLayers();
      };
  async function syncReport() {
    if (busy) return;
    busy = true;
    reportRequest++;
    for (const id of ['sync-report', 'disconnect-report', 'report-link']) $(id).disabled = true;
    $('report-progress').textContent = 'Loading eBird trip report…';
    try {
      const id = normalizeWorkspaceReportId($('report-link').value);
      const report = await loadWorkspaceReport(id, {
        details: true,
        signal: abort.signal,
        onProgress: (text) => {
          $('report-progress').textContent = text;
        },
      });
      if (disposed) return;
      await options.onReport(report);
      if (disposed) return;
      reportId = id;
      installReport(report);
      queueSave();
      $('report-progress').textContent = 'Updated';
    } catch (error) {
      if (!disposed) $('report-progress').textContent = error.message;
    } finally {
      busy = false;
      if (!disposed)
        for (const id of ['sync-report', 'disconnect-report', 'report-link'])
          $(id).disabled = false;
    }
  }
  function installReport(report) {
    planningCache = null;
    selectionStatsKey = '';
    reportAggregates.clear();
    data.reportTaxa = report.taxa;
    data.reportChecklists = report.checklists;
    synced = true;
    for (const t of report.taxa)
      if (!taxa.has(t.speciesCode)) {
        const item = {
          code: t.speciesCode,
          name: t.commonName,
          latin: t.sciName,
          category: t.category,
          ebd: false,
          life: null,
          region: null,
        };
        taxa.set(item.code, item);
        data.taxa.push(item);
      }
    for (const stop of stops)
      memberships.set(
        stop.id,
        new Set(
          stop.type === 'Birding'
            ? data.reportChecklists
                .filter((c) => distance(stop.coords, c.coords) <= stop.radius)
                .map((c) => c.id)
            : [],
        ),
      );
    renderJourney();
    renderList();
    renderSelectionStats();
    renderSpecies();
    drawLayers();
    drawMarkers();
  }
  $('sync-report').onclick = syncReport;
  $('disconnect-report').onclick = () => {
    planningCache = null;
    selectionStatsKey = '';
    reportAggregates.clear();
    reportRequest++;
    reportId = '';
    synced = false;
    data.reportChecklists = [];
    data.reportTaxa = [];
    renderJourney();
    renderList();
    renderEditor();
    renderSpecies();
    drawLayers();
    drawMarkers();
    queueSave();
  };
  $('cluster-species').innerHTML = data.taxa
    .map((t) => '<option>' + escape(t.name) + '</option>')
    .join('');
  $('cluster-settings').onclick = () => $('cluster-dialog').showModal();
  $('close-clusters').onclick = () => $('cluster-dialog').close();
  $('species-layer').onchange = () => {
    if ($('species-layer').checked && !clusterFeatures.length) {
      $('species-layer').checked = false;
      $('cluster-dialog').showModal();
    }
    drawLayers();
  };
  let clusterWorker;
  $('compute-clusters').onclick = () => {
    $('compute-clusters').disabled = true;
    $('cluster-progress').innerHTML =
      '<progress aria-label="Computing reporting rates"></progress> Grouping EBD locations…';
    const name = $('cluster-species').value,
      code = data.taxa.find((t) => t.name === name).code,
      minimum = Number($('cluster-minimum').value),
      km = Number($('cluster-distance').value);
    clusterWorker = new Worker(new URL('./clusterWorker.js', import.meta.url), { type: 'module' });
    const failed = (message) => {
      $('cluster-progress').textContent = message;
      $('compute-clusters').disabled = false;
      clusterWorker.terminate();
      clusterWorker = null;
    };
    clusterWorker.onerror = (e) => failed(e.message);
    clusterWorker.onmessage = ({ data: result }) => {
      if (result.error) {
        failed(result.error);
        return;
      }
      clusterFeatures = result.features;
      layer = name;
      $('species-layer').checked = true;
      $('cluster-status').textContent =
        name + ' · ' + clusterFeatures.length + ' clusters · ' + km + ' km';
      $('cluster-dialog').close();
      $('compute-clusters').disabled = false;
      $('cluster-progress').textContent = 'Historical EBD export';
      clusterWorker.terminate();
      clusterWorker = null;
      drawLayers();
    };
    clusterWorker.postMessage({
      km,
      locations: data.ebdLocations
        .filter((l) => l.count >= minimum)
        .map((l) => ({ coords: l.coords, count: l.count, recorded: l.counts[code] || 0 })),
    });
  };
  const media = matchMedia('(max-width:700px)');
  const screen = () => {
    $('workspace-layout').classList.toggle('mobile', media.matches);
    root.querySelector('.header-menu').open = !media.matches;
    map.resize();
  };
  media.addEventListener('change', screen, { signal: abort.signal });
  screen();
  // Index immutable locations once; only geometry/type edits repeat spatial selection.
  for (const stop of stops) computeSpatial(stop);
  renderAccess();
  renderList();
  renderEditor();
  renderSpecies();
  setView(view);
  if (reportId && !synced && navigator.onLine) {
    const request = ++reportRequest;
    loadWorkspaceReport(reportId, { signal: abort.signal })
      .then(async (report) => {
        if (disposed || request !== reportRequest) return;
        await options.onReport(report);
        if (!disposed && request === reportRequest) installReport(report);
      })
      .catch((error) => {
        if (!disposed) feedback(error.message);
      });
  }
  return {
    setMetadata(plan) {
      if (data.name === plan.name && data.timeZone === plan.timeZone) return;
      data.name = plan.name;
      data.timeZone = plan.timeZone;
      planningCache = null;
      selectionStatsKey = '';
      renderAccess();
      renderList();
      renderEditor();
    },
    // A collaborator's merged changes: swap the stops in place without saving them back.
    // Undo history predates the merge, so replaying it would revert their edits.
    replacePlan(next) {
      for (const item of next.taxa) if (!taxa.has(item.code)) taxa.set(item.code, { ...item });
      data.start = next.start;
      data.end = next.end;
      const nextStops = structuredClone(next.stops);
      const keep = nextStops.some((s) => s.id === selected);
      if (!keep) lastDetailStop = 0;
      installStops({
        stops: nextStops,
        routes: nextStops.filter((s) => s.route.geometry).map((s) => [s.id, s.route]),
        selected: keep
          ? selected
          : nextStops.find((s) => s.type === 'Birding')?.id || nextStops[0]?.id || 0,
      });
      undoStack.length = 0;
      redoStack.length = 0;
      renderHistory();
      renderList();
      renderEditor();
      renderSpecies();
      drawMarkers();
      drawLayers();
    },
    destroy() {
      disposed = true;
      clusterWorker?.terminate();
      abort.abort();
      resizeObserver.disconnect();
      closePopup();
      map.remove();
    },
    getPlan: () => workspaceModelPlan(options.getPlan(), stops, routes, reportId, taxa),
  };
}
