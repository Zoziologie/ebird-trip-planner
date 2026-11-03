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

export const samePlan = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
      `This itinerary is ${Math.ceil(bytes / 1024)} KiB; cloud autosave supports plans up to 900 KiB. Your device edits are kept; download a backup from My trips.`,
    );
  }
};
