import tzLookup from '@photostructure/tz-lookup';

// An empty saved zone means automatic; an empty itinerary has no local clock yet.
export const tripTimeZone = (override, latitude, longitude) =>
  override || (latitude == null || longitude == null ? 'UTC' : tzLookup(latitude, longitude));
