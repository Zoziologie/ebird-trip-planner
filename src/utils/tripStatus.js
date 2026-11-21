// What a trip card says, as two separate questions: is the trip on this device (so it opens
// offline), and is it backed up to the cloud. A third tag marks trips someone shared.
// `syncState` comes from the sync coordinator (workspaceSyncStates in state/workspaceSync.js),
// the single place that compares this device's copy with the cloud.

const chip = (id, icon, label, tone, title = '') => ({ id, icon, label, tone, title });
const shared = (item) =>
  item.cloud && item.cloud.owned === false
    ? [chip('shared', 'people', 'Shared with you', 'muted', 'Someone else owns this cloud trip.')]
    : [];
const backup = (item, syncState, message) => {
  if (!item.sync?.cloudId)
    return chip(
      'device-only',
      'cloud-slash',
      'Not backed up',
      'muted',
      item.cloudId
        ? 'An older cloud copy exists, but edits here are not synced. Enable cloud autosave.'
        : 'Only this device has it. Enable cloud autosave or export a copy.',
    );
  switch (syncState) {
    case 'synced':
      return chip('synced', 'cloud-check', 'Backed up', 'ok', 'Matches the cloud copy.');
    case 'pending':
      return chip(
        'pending',
        'cloud-upload',
        'Changes to upload',
        'warn',
        'Saved on this device. They upload when you are back online.',
      );
    case 'syncing':
      return chip('syncing', 'arrow-repeat', 'Syncing…', 'muted');
    case 'sign-in':
      return chip(
        'sign-in',
        'cloud-slash',
        'Sign in to sync',
        'warn',
        'Changes stay on this device until you sign in with the account that owns this copy.',
      );
    case 'error':
      return chip('error', 'exclamation-triangle', 'Not synced', 'warn', message);
    default:
      return chip('cloud', 'cloud', 'Cloud autosave', 'muted');
  }
};

export function tripCardStatus(item, syncState, message = '') {
  if (!item.localId)
    return [
      chip(
        'cloud-only',
        'cloud-arrow-down',
        'Not on this device',
        'muted',
        'Saved in the cloud only. Download it while online to use it offline.',
      ),
      ...shared(item),
    ];
  return [
    chip('on-device', 'phone', 'On this device', 'ok', 'Opens and saves without a connection.'),
    backup(item, syncState, message),
    ...shared(item),
  ];
}

// Map tiles detailed enough to find your way at a stop (about 1:250 000 and closer).
const DETAIL_ZOOM = 11;
const tileAt = (longitude, latitude, z) => {
  const n = 2 ** z;
  const rad = (latitude * Math.PI) / 180;
  const x = Math.floor(((longitude + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return `${z}/${x}/${y}`;
};
// Stops with a detailed cached map tile under them, in any Mapbox tileset.
// `cachedTiles` holds `tileset/z/x/y` keys (see offlineBasemap.js).
export function stopsWithMap(stops, cachedTiles) {
  const tiles = new Set([...cachedTiles].map((key) => key.split('/').slice(-3).join('/')));
  return stops.filter(({ longitude, latitude }) => {
    for (let z = DETAIL_ZOOM; z <= 16; z++)
      if (tiles.has(tileAt(longitude, latitude, z))) return true;
    return false;
  });
}

// Checklist shown before a trip: each item is ok, todo or info.
export function offlineReadiness(
  item,
  syncState,
  { mapStops = 0, installed = false, persisted = false, ios = false },
) {
  const checks = [];
  const add = (state, title, detail = '', action = '') =>
    checks.push({ state, title, detail, action });
  if (!item.localId) {
    add('todo', 'Not on this device', 'Download it while you still have a connection.', 'download');
  } else {
    add('ok', 'Saved on this device', 'Opens and saves changes without a connection.');
    const state = backup(item, syncState).id;
    if (state === 'device-only')
      add(
        'info',
        'Not backed up',
        'Only this device has it. Export a copy or enable cloud autosave.',
      );
    else if (state === 'pending')
      add(
        'todo',
        'Changes not uploaded yet',
        'Go online once before you leave so they reach the cloud.',
      );
    else if (state === 'sign-in')
      add('todo', 'Not syncing', 'Sign in with the account that owns this copy.');
    else if (state === 'error')
      add('todo', 'Last sync failed', 'Open the trip online to see why and retry.');
    else if (state === 'synced') add('ok', 'Backed up to the cloud');
    else add('info', 'Checking the cloud copy…');
    const stops = item.visits?.length || 0;
    if (stops)
      add(
        mapStops === stops ? 'ok' : 'todo',
        mapStops === stops
          ? `Detailed map saved around all ${stops} ${stops === 1 ? 'stop' : 'stops'}`
          : `Detailed map saved around ${mapStops} of ${stops} stops`,
        mapStops === stops
          ? ''
          : 'While online, open the trip and zoom in on each stop. Elsewhere a simple world map is shown.',
      );
  }
  add(
    installed ? 'ok' : 'todo',
    installed ? 'Installed as an app' : 'Not installed as an app',
    installed
      ? ''
      : ios
        ? 'In Safari: Share → Add to Home Screen, then open it from there. Safari can clear data of sites not added to the home screen.'
        : 'Use “Install app” in the browser menu, then open it from there.',
  );
  if (!persisted)
    add(
      'info',
      'Storage not protected yet',
      'The browser may clear saved trips when the device runs low on space. Installing the app usually protects it.',
    );
  add(
    'info',
    'Needs a connection anyway',
    'Routing new stops, place search, signing in and species links to eBird or Birds of the World.',
  );
  return checks;
}
