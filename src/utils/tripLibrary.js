// A cloud trip and its downloaded browser copy are one item in the trip library.
export const buildTripLibrary = (localTrips, cloudTrips, bindings, editTimes, visitCounts) => {
  const cloudById = new Map(
    cloudTrips.filter((trip) => trip.revision).map((trip) => [trip.id, trip]),
  );
  const linkedIds = new Set();
  const items = localTrips.map((trip) => {
    const binding = bindings[trip.id];
    const cloud = cloudById.get(binding?.id);
    if (binding) linkedIds.add(binding.id);
    const localEditedAt = editTimes[trip.id] || Number(trip.updatedAt || 0);
    const cloudSavedAt = cloud?.updatedAt?.toMillis() || binding?.savedAt || 0;
    const changed =
      binding &&
      (localEditedAt !== binding.savedLocalEdit ||
        (visitCounts[trip.id] || 0) !== binding.savedVisitCount);
    return {
      key: `browser:${trip.id}`,
      localId: trip.id,
      cloudId: binding?.id || '',
      name: trip.name,
      localEditedAt,
      cloudSavedAt,
      cloudName: cloud?.name || '',
      storage: !binding
        ? 'Browser only'
        : cloud
          ? cloud.owned
            ? 'Your cloud trip'
            : 'Shared cloud trip'
          : 'Cloud linked',
      status: !binding
        ? ''
        : cloud && cloud.revision !== binding.revision
          ? 'Newer version in cloud'
          : changed
            ? 'Browser changes to save'
            : 'Matches last cloud save',
    };
  });
  for (const cloud of cloudById.values()) {
    if (!linkedIds.has(cloud.id))
      items.push({
        key: `cloud:${cloud.id}`,
        localId: '',
        cloudId: cloud.id,
        name: cloud.name,
        localEditedAt: 0,
        cloudSavedAt: cloud.updatedAt?.toMillis() || 0,
        storage: cloud.owned ? 'Your cloud trip' : 'Shared cloud trip',
        status: 'Open to use in this browser',
      });
  }
  return items.sort(
    (a, b) => Math.max(b.localEditedAt, b.cloudSavedAt) - Math.max(a.localEditedAt, a.cloudSavedAt),
  );
};
