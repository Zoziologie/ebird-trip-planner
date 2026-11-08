import { clustersDbscan, featureCollection, point } from '@turf/turf';

// Keep the existing clustering calculation off the UI thread, even for large EBD exports.
self.onmessage = ({ data: { locations, km } }) => {
  try {
    const grouped = clustersDbscan(
      featureCollection(
        locations.map((l) => point(l.coords, { count: l.count, recorded: l.recorded })),
      ),
      km,
      { units: 'kilometers', minPoints: 1 },
    );
    const groups = new Map();
    grouped.features.forEach((f, i) => {
      const id = f.properties.cluster ?? i;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(f);
    });
    const features = [...groups.values()].map((items) => {
      const count = items.reduce((sum, f) => sum + f.properties.count, 0),
        recorded = items.reduce((sum, f) => sum + f.properties.recorded, 0);
      return point(
        [0, 1].map(
          (axis) => items.reduce((sum, f) => sum + f.geometry.coordinates[axis], 0) / items.length,
        ),
        { count, rate: recorded / count },
      );
    });
    self.postMessage({ features });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
