import { compactRouteGeometry } from './routeGeometry.js';

// Shared plans contain only itinerary content. Personal lists and EBD stay separate.
export const buildWorkspacePlan = (trip, visits) => ({
  version: 1,
  name: trip.name,
  timeZone: trip.timeZone || '',
  reportId: trip.tripReportId || '',
  stops: [...visits]
    .sort(
      (a, b) =>
        String(a.dateTime || '').localeCompare(String(b.dateTime || '')) ||
        Number(a.id) - Number(b.id),
    )
    .map((visit) => ({
      id: visit.workspaceId,
      name: visit.name || '',
      type: visit.type || 'birding',
      dateTime: visit.dateTime || '',
      durationMinutes: Number(visit.durationMin || 0) * 60,
      longitude: visit.longitude,
      latitude: visit.latitude,
      radiusMeters: Number(visit.radiusKm || 0) * 1000,
      note: visit.note || '',
      targetSpecies: [...(visit.targetSpecies || [])],
      // Firestore rejects nested coordinate arrays; keep geometry as compact JSON.
      routeGeometryJson: visit.routeGeometry
        ? JSON.stringify(compactRouteGeometry(visit.routeGeometry))
        : '',
      routeDistanceM: Number(visit.routeDistanceM || 0),
      routeDurationS: Number(visit.routeDurationS || 0),
    })),
});

// The production editor still uses hours under the legacy durationMin name.
export const workspaceVisits = (plan, tripId, previous = [], now = Date.now()) =>
  plan.stops.map((stop) => {
    const old = previous.find((visit) => visit.workspaceId === stop.id);
    const unchangedArea =
      old &&
      old.longitude === stop.longitude &&
      old.latitude === stop.latitude &&
      Number(old.radiusKm) === stop.radiusMeters / 1000 &&
      Number(old.durationMin) === stop.durationMinutes / 60 &&
      (old.type || 'birding') === stop.type;
    return {
      ...Object.fromEntries(
        Object.entries(old || {}).filter(([key]) => unchangedArea || !key.startsWith('stats')),
      ),
      workspaceId: stop.id,
      tripId,
      name: stop.name,
      type: stop.type,
      dateTime: stop.dateTime,
      durationMin: stop.durationMinutes / 60,
      longitude: stop.longitude,
      latitude: stop.latitude,
      radiusKm: stop.radiusMeters / 1000,
      note: stop.note,
      targetSpecies: stop.targetSpecies,
      routeGeometry: stop.routeGeometryJson ? JSON.parse(stop.routeGeometryJson) : null,
      routeDistanceM: stop.routeDistanceM,
      routeDurationS: stop.routeDurationS,
      createdAt: old?.createdAt || now,
      updatedAt: now,
    };
  });

// Stop order is derived (date, then device-local insertion), so it never counts as an edit.
const canonical = (value) =>
  Array.isArray(value?.stops)
    ? { ...value, stops: [...value.stops].sort((a, b) => String(a.id).localeCompare(b.id)) }
    : value;
export const samePlan = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// Fields that only make sense together merge as one unit.
const STOP_GROUPS = [
  ['name'],
  ['type'],
  ['dateTime'],
  ['durationMinutes'],
  ['longitude', 'latitude'],
  ['radiusMeters'],
  ['note'],
  ['targetSpecies'],
  ['routeGeometryJson', 'routeDistanceM', 'routeDurationS'],
];
const PLAN_FIELDS = ['name', 'timeZone', 'reportId'];
const pick = (item, keys) => JSON.stringify(keys.map((key) => item?.[key]));

// Three-way merge of shared plans. Stops merge by id and field group, so concurrent
// edits to different stops or fields both survive. When both sides changed the same
// field, `prefer` wins and the conflict is counted; when one side deleted a stop the
// other edited, the edited stop is kept.
export const mergePlans = (base, local, remote, { prefer = 'remote' } = {}) => {
  if (!base) return { plan: prefer === 'local' ? local : remote, conflicts: 0 };
  let conflicts = 0;
  const choose = (keys, b, l, r) => {
    const [kb, kl, kr] = [pick(b, keys), pick(l, keys), pick(r, keys)];
    if (kl === kr || kl === kb) return r;
    if (kr === kb) return l;
    conflicts++;
    return prefer === 'local' ? l : r;
  };
  const plan = { ...remote };
  for (const key of PLAN_FIELDS) plan[key] = choose([key], base, local, remote)[key];
  const byId = (items) => new Map(items.map((stop) => [stop.id, stop]));
  const [baseStops, localStops, remoteStops] = [base, local, remote].map((p) => byId(p.stops));
  const merged = new Map();
  for (const id of new Set([...remoteStops.keys(), ...localStops.keys()])) {
    const b = baseStops.get(id),
      l = localStops.get(id),
      r = remoteStops.get(id);
    if (!b) {
      // New on one side; on both only when this device's own commit already landed.
      merged.set(id, l || r);
      continue;
    }
    if (!l || !r) {
      // A deletion stands unless the other side edited the stop meanwhile.
      const kept = l || r;
      if (!samePlan(kept, b)) {
        conflicts++;
        merged.set(id, kept);
      }
      continue;
    }
    const stop = { ...r };
    for (const keys of STOP_GROUPS) {
      const source = choose(keys, b, l, r);
      for (const key of keys) stop[key] = source[key];
    }
    merged.set(id, stop);
  }
  // Order matches buildWorkspacePlan; stable ties keep the remote order first.
  plan.stops = [...merged.values()].sort((a, b) =>
    String(a.dateTime || '').localeCompare(String(b.dateTime || '')),
  );
  return { plan, conflicts };
};

export const publicationDecision = (current, baseRevision, commitId) => {
  if (current.commitId === commitId) return 'acknowledged';
  return current.revision === baseRevision ? 'publish' : 'conflict';
};

export const datasetArchive = (payload) => ({
  version: 3,
  trip: {
    id: payload.trip.id,
    name: payload.trip.name,
    createdAt: payload.trip.createdAt || 0,
    updatedAt: payload.trip.updatedAt || 0,
  },
  ebd: payload.ebd && {
    ...payload.ebd,
    speciesList: payload.ebd.speciesList.map(
      ({ liferWorld, liferRegion, tripReportSeen, ...species }) => species,
    ),
  },
  visits: [],
  lists: [],
  checklists: payload.checklists,
  comments: payload.comments,
});

export const validatePlanSize = (plan) => {
  // Keep 124 KiB below Firestore's 1 MiB document limit for metadata and field overhead.
  const bytes = new TextEncoder().encode(JSON.stringify(plan)).length;
  if (bytes > 900 * 1024) {
    throw new Error(
      `This itinerary is ${Math.ceil(bytes / 1024)} KiB; cloud autosave supports plans up to 900 KiB. Your device edits are kept; export the trip (.ebirdtrip) from My trips.`,
    );
  }
};
