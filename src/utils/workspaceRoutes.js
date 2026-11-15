// A route belongs to the directed leg from the preceding stop to its destination.
export const retainWorkspaceRoutes = (previousStops, stops, routes) => {
  const previousFrom = new Map(previousStops.map((stop, i) => [stop.id, previousStops[i - 1]?.id]));
  return new Map(
    stops.flatMap((stop, i) =>
      i > 0 && previousFrom.get(stop.id) === stops[i - 1].id && routes.has(stop.id)
        ? [[stop.id, routes.get(stop.id)]]
        : [],
    ),
  );
};

// Mapbox needs the itinerary clock, which may differ from the road's local zone.
export function routeArrivalTime(localTime, timeZone) {
  const wallTime = Date.parse(localTime + 'Z');
  const format = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'longOffset' });
  const offsetAt = (time) => {
    const offset = format.formatToParts(time).find((part) => part.type === 'timeZoneName').value;
    const [, sign, hours, minutes] = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset) || [];
    return sign ? (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60000 : 0;
  };
  return (
    new Date(wallTime - offsetAt(wallTime - offsetAt(wallTime))).toISOString().slice(0, 19) + 'Z'
  );
}
