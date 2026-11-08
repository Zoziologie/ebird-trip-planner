import { compactRouteGeometry } from './routeGeometry.js';

// Adapt the existing trip archive to the reviewed workspace's presentation model.
export const workspaceModel = (plan, ebd, comments = [], report = null, taxonomy = {}) => {
  const taxa = (ebd?.speciesList || []).map((t) => ({
    code: t.code,
    name: t.commonName,
    latin: t.scientificName || '',
    category: t.category || 'species',
    order: t.taxonOrder || 99999,
    life: t.liferWorld ?? null,
    region: t.liferRegion ?? null,
    ebd: true,
  }));
  for (const t of report?.taxa || [])
    if (!taxa.some((s) => s.code === t.speciesCode))
      taxa.push({
        code: t.speciesCode,
        name: t.commonName,
        latin: t.sciName,
        category: t.category,
        order: t.taxonOrder,
        life: null,
        region: null,
        ebd: false,
      });
  for (const code of new Set(plan.stops.flatMap((s) => s.targetSpecies))) {
    const t = taxonomy[code];
    if (t && !taxa.some((s) => s.code === code))
      taxa.push({
        code,
        name: t.comName,
        latin: t.sciName,
        category: t.category,
        order: t.taxonOrder,
        life: null,
        region: null,
        ebd: false,
      });
  }
  const names = new Map(taxa.map((t) => [t.code, t.name]));
  const stops = plan.stops.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type[0].toUpperCase() + s.type.slice(1),
    date: s.dateTime,
    duration: s.durationMinutes / 60,
    radius: s.radiusMeters / 1000,
    coords: [s.longitude, s.latitude],
    note: s.note,
    targets: s.targetSpecies.map((code) => names.get(code) || code),
    historicalCount: 0,
    historicalSpecies: {},
    route: {
      geometry: s.routeGeometryJson ? JSON.parse(s.routeGeometryJson) : null,
      distance: s.routeDistanceM,
      duration: s.routeDurationS,
    },
  }));
  if (!comments.length)
    comments = (ebd?.locations || []).flatMap((l) =>
      (l.checklist || [])
        .filter((c) => c.checklist_comment || c.species?.some((s) => s.species_comment))
        .map((c) => ({
          locality_id: String(l.locality_id),
          checklist_id: c.checklist_id,
          date: c.date,
          time: c.time,
          duration_minutes: c.duration_minutes,
          checklist_comment: c.checklist_comment || '',
          species_comments: (c.species || [])
            .filter((s) => s.species_comment)
            .map((s) => [
              s.code,
              s.species_comment.split('\nURN:CornellLabOfOrnithology:')[0].trim(),
            ]),
        })),
    );
  const dates = stops
    .map((s) => s.date.slice(0, 10))
    .filter(Boolean)
    .sort();
  return {
    name: plan.name,
    timeZone: plan.timeZone,
    reportId: plan.reportId,
    start: dates[0] || new Date().toISOString().slice(0, 10),
    end: dates.at(-1) || new Date().toISOString().slice(0, 10),
    stops,
    taxa,
    reportTaxa: report?.taxa || [],
    reportChecklists: report?.checklists || [],
    comments,
    ebdLocations: (ebd?.locations || []).map((l) => ({
      id: String(l.locality_id),
      name: l.locality,
      coords: [l.longitude, l.latitude],
      hotspot: Boolean(l.locality_hotspot),
      count: l.checklist_count_complete ?? l.checklist_count,
      totalCount: l.checklist_count,
      counts: Object.fromEntries(l.species_checklist_counts || []),
      durations:
        l.checklist_durations ||
        (l.checklist || []).map((c) => c.duration_minutes).filter((n) => n > 0),
      distances:
        l.checklist_distances_km ||
        (l.checklist || []).map((c) => c.effort_distance_km).filter((n) => n > 0),
    })),
  };
};

export const workspaceModelPlan = (base, stops, routes, reportId, taxa) => {
  const codes = new Map([...taxa.values()].map((t) => [t.name, t.code]));
  return {
    ...base,
    reportId,
    stops: stops.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type.toLowerCase(),
      dateTime: s.date,
      durationMinutes: s.duration * 60,
      longitude: s.coords[0],
      latitude: s.coords[1],
      radiusMeters: s.radius * 1000,
      note: s.note,
      targetSpecies: s.targets.map((name) => codes.get(name) || name),
      routeGeometryJson: routes.get(s.id)?.geometry
        ? JSON.stringify(compactRouteGeometry(routes.get(s.id).geometry))
        : '',
      routeDistanceM: routes.get(s.id)?.distance || 0,
      routeDurationS: routes.get(s.id)?.duration || 0,
    })),
  };
};
