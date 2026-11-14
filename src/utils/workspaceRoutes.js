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
