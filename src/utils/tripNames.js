export const findTripByName = (trips, name) =>
  trips.find((trip) => trip.name.trim().toLowerCase() === name.trim().toLowerCase());

export const uniqueTripName = (trips, name) => {
  const base = name.trim() || 'New trip';
  let candidate = base;
  for (let index = 2; findTripByName(trips, candidate); index++) candidate = `${base} ${index}`;
  return candidate;
};
