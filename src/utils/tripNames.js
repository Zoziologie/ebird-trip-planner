export const findTripByName = (trips, name) =>
  trips.find((trip) => trip.name.trim().toLowerCase() === name.trim().toLowerCase());

export const uniqueTripName = (trips, name) => {
  const base = name.trim() || 'New trip';
  let candidate = base;
  for (let index = 2; findTripByName(trips, candidate); index++) candidate = `${base} ${index}`;
  return candidate;
};

// Preserve separate saved trips while making existing name collisions unambiguous.
export const uniqueTripLabels = (trips) => {
  const used = [];
  return trips.map((trip) => {
    const name = uniqueTripName(
      [
        ...used,
        ...trips.filter(
          (item) =>
            item !== trip && item.name.trim().toLowerCase() !== trip.name.trim().toLowerCase(),
        ),
      ],
      trip.name,
    );
    used.push({ name });
    return { ...trip, name };
  });
};

export const tripCloudId = (trip, bindings) => trip.sync?.cloudId || bindings[trip.id]?.id || '';
