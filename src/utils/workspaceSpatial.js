import { distance } from '@turf/turf';

// Latitude-sorted immutable EBD locations: shortlist a narrow band before exact spherical distance.
export const workspaceSpatialIndex = (locations) => {
  const sorted = [...locations].sort((a, b) => a.coords[1] - b.coords[1]);
  return (center, radius) => {
    const radians = radius / 6371.0088,
      latitude = (center[1] * Math.PI) / 180;
    const latSpan = (radians * 180) / Math.PI;
    const lonSpan =
      Math.abs(latitude) + radians >= Math.PI / 2
        ? 180
        : (Math.asin(Math.sin(radians) / Math.cos(latitude)) * 180) / Math.PI;
    let low = 0,
      high = sorted.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (sorted[mid].coords[1] < center[1] - latSpan) low = mid + 1;
      else high = mid;
    }
    const found = [];
    for (let i = low; i < sorted.length && sorted[i].coords[1] <= center[1] + latSpan; i++) {
      const l = sorted[i],
        delta = Math.abs(((l.coords[0] - center[0] + 540) % 360) - 180);
      if (delta <= lonSpan && distance(center, l.coords) <= radius) found.push(l);
    }
    return found;
  };
};

// Name a stop for the best-recorded location in its area, falling back to the nearest outside it.
export const workspaceNamingLocation = (locations, center, radius) => {
  const ranked = locations.map((location) => ({
    location,
    count: location.count + location.incompleteCount,
    distance: distance(center, location.coords),
  }));
  const nearby = ranked.filter((entry) => entry.distance <= radius);
  return (nearby.length ? nearby : ranked).sort(
    (a, b) =>
      (nearby.length ? b.count - a.count : 0) ||
      a.distance - b.distance ||
      a.location.id.localeCompare(b.location.id),
  )[0]?.location;
};
