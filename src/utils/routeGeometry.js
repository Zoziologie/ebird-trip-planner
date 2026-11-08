import { distance, toMercator } from '@turf/turf';
import simplify from 'simplify-js';

// Preserve access roads verbatim; simplify only the middle of longer drives.
export const compactRouteGeometry = (geometry) => {
  const coordinates = geometry.coordinates;
  let first = 0,
    last = coordinates.length - 1,
    meters = 0;
  while (first < last && meters < 5000) {
    meters += distance(coordinates[first], coordinates[first + 1], { units: 'meters' });
    first++;
  }
  meters = 0;
  while (last > first && meters < 5000) {
    meters += distance(coordinates[last], coordinates[last - 1], { units: 'meters' });
    last--;
  }
  if (first >= last) return geometry;

  // Mercator exaggerates ground distances, so 25 projected metres is conservative.
  // Unwrap longitude at the date line before measuring deviations.
  const worldWidth = 2 * Math.PI * 6378137;
  let previousX;
  const middle = coordinates.slice(first, last + 1).map((coordinate) => {
    let [x, y] = toMercator(coordinate);
    if (previousX !== undefined) x += Math.round((previousX - x) / worldWidth) * worldWidth;
    previousX = x;
    return { x, y, coordinate };
  });
  return {
    ...geometry,
    coordinates: [
      ...coordinates.slice(0, first),
      ...simplify(middle, 25, true).map((point) => point.coordinate),
      ...coordinates.slice(last + 1),
    ],
  };
};
