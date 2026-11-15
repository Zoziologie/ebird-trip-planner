import { circle } from '@turf/turf';

export const speciesLinkOptions = [
  { id: 'ebird', label: 'eBird species · region', icon: 'feather', visible: true },
  { id: 'map', label: 'eBird species map', icon: 'map', visible: true },
  { id: 'bow', label: 'Birds of the World', icon: 'book', visible: true },
  { id: 'photos', label: 'Macaulay photos · best rated in region', icon: 'camera', visible: true },
  {
    id: 'audio',
    label: 'Macaulay audio · best rated in region',
    icon: 'volume-up',
    visible: false,
  },
];

export function speciesMapBounds(coords, stop) {
  const extent = stop
    ? circle(stop.coords, Math.max(stop.radius, 1)).geometry.coordinates[0]
    : coords;
  if (!extent.length) return {};
  let west = 180,
    east = -180,
    south = 90,
    north = -90;
  for (const [lng, lat] of extent) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  // Keep small datasets visible at a useful map scale.
  const dx = Math.max((east - west) * 0.05, stop ? 0 : 0.05),
    dy = Math.max((north - south) * 0.05, stop ? 0 : 0.05);
  return {
    'env.minX': Math.max(-180, west - dx),
    'env.maxX': Math.min(180, east + dx),
    'env.minY': Math.max(-90, south - dy),
    'env.maxY': Math.min(90, north + dy),
  };
}

export function speciesLinkUrls(code, region, bounds) {
  const species = encodeURIComponent(code);
  const map = new URLSearchParams({ zh: 'true', gp: 'true', yr: 'all', mr: '1-12', ...bounds });
  const media = new URLSearchParams({ taxonCode: code, sort: 'rating_rank_desc' });
  if (region) media.set('regionCode', region);
  return {
    ebird: `https://ebird.org/species/${species}${region ? '/' + encodeURIComponent(region) : ''}`,
    map: `https://ebird.org/map/${species}?${map}`,
    bow: `https://birdsoftheworld.org/bow/species/${species}/cur/introduction`,
    photos: `https://search.macaulaylibrary.org/catalog?${media}&mediaType=p`,
    audio: `https://search.macaulaylibrary.org/catalog?${media}&mediaType=a`,
  };
}
