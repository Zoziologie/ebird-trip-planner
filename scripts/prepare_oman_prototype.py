"""Build a compact local prototype fixture from an Oman archive and public report 468402."""
import argparse
import collections
import concurrent.futures
import datetime
import json
import math
from pathlib import Path
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--archive', type=Path, required=True)
parser.add_argument('--cache', type=Path, required=True)
parser.add_argument('--output', type=Path, default=Path('docs/prototypes/oman-data.json'))
args = parser.parse_args()
args.cache.mkdir(parents=True, exist_ok=True)
api = 'https://tripreport.raphaelnussbaumer.com/tripreport-internal/v1'


def cached_json(endpoint, filename):
    path = args.cache / filename
    if not path.exists():
        with urllib.request.urlopen(f'{api}/{endpoint}', timeout=30) as response:
            path.write_text(json.dumps(json.load(response)))
    return json.loads(path.read_text())


def distance(a, b):
    x1, y1, x2, y2 = map(math.radians, (*a, *b))
    return 12742 * math.asin(min(1, math.sqrt(math.sin((y2 - y1) / 2) ** 2 + math.cos(y1) * math.cos(y2) * math.sin((x2 - x1) / 2) ** 2)))


def simplify(geometry):
    if not geometry:
        return None
    coordinates = geometry['coordinates']
    result = coordinates[::max(1, len(coordinates) // 100)]
    if result[-1] != coordinates[-1]:
        result.append(coordinates[-1])
    return {'type': 'LineString', 'coordinates': [[round(v, 5) for v in point] for point in result]}


def taxon_detail(taxon):
    code = taxon['speciesCode']
    return code, cached_json(f'taxon-detail/468402/{code}', f'{code}.json')


archive = json.loads(args.archive.read_text())
report_taxa = cached_json('taxon-list/468402', 'taxon-list.json')
report_checklists = cached_json('checklists/468402', 'checklists.json')
locations = archive['ebd']['locations']
ebd_species_codes = {s['code'] for s in archive['ebd']['speciesList']}
taxonomy = {s['code']: s for s in archive['ebd']['speciesList']}
for taxon in report_taxa:
    taxonomy[taxon['speciesCode']] = {**taxonomy.get(taxon['speciesCode'], {}), 'code': taxon['speciesCode'], 'commonName': taxon['commonName'], 'scientificName': taxon['sciName'], 'category': taxon['category']}

# Keep only data required for replay and aggregation; omit observer identifiers; keep EBD observation comments for local export.
checklists = {c['subId']: {'id': c['subId'], 'locId': c['locId'], 'name': c['loc']['name'], 'coords': [c['loc']['longitude'], c['loc']['latitude']], 'hotspot': c['loc']['isHotspot'], 'date': c['isoObsDate'].replace(' ', 'T'), 'declaredSpecies': c['numSpecies'], 'species': {}} for c in report_checklists}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    for code, detail in pool.map(taxon_detail, report_taxa):
        for observation in detail.get('checklists', []):
            if observation['subId'] in checklists:
                checklists[observation['subId']]['species'][code] = observation.get('howMany', 'X')

stops = []
for visit in sorted(archive['visits'], key=lambda v: v['dateTime']):
    coordinates = [visit['longitude'], visit['latitude']]
    nearby = [loc for loc in locations if distance(coordinates, [loc['longitude'], loc['latitude']]) <= visit['radiusKm']]
    counts = collections.Counter()
    for loc in nearby:
        counts.update(dict(loc['species_checklist_counts']))
    # Preserve the existing Build Trip UI's hours convention for the durationMin field.
    stops.append({'id': visit['id'], 'name': visit['name'], 'date': visit['dateTime'], 'type': visit['type'].title(), 'duration': visit['durationMin'], 'radius': visit['radiusKm'], 'coords': coordinates, 'targets': [taxonomy[code]['commonName'] for code in visit['targetSpecies'] if code in taxonomy], 'note': visit['note'], 'historicalCount': sum(loc.get('checklist_count_complete', loc['checklist_count']) for loc in nearby), 'historicalSpecies': dict(counts), 'route': {'geometry': simplify(visit.get('routeGeometry')), 'distance': visit.get('routeDistanceM', 0), 'duration': visit.get('routeDurationS', 0)}})

fixture = {'reportId': '468402', 'name': 'Oman · Coast, Dhofar & mountains', 'start': '2026-02-06', 'end': '2026-02-26', 'during': '2026-02-16T23:59', 'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'stops': stops, 'taxa': [{'code': code, 'name': t['commonName'], 'latin': t.get('scientificName', ''), 'category': t.get('category', 'species'), 'ebd': code in ebd_species_codes, 'order': t.get('taxonOrder', 99999), 'life': t.get('liferWorld'), 'region': t.get('liferRegion')} for code, t in taxonomy.items()], 'reportChecklists': list(checklists.values()), 'ebdLocations': [{'id': loc['locality_id'], 'name': loc['locality'], 'coords': [loc['longitude'], loc['latitude']], 'hotspot': loc.get('locality_hotspot', False), 'count': loc.get('checklist_count_complete', loc['checklist_count']), 'totalCount': loc['checklist_count'], 'counts': dict(loc['species_checklist_counts']), 'durations': [c['duration_minutes'] for c in loc['checklist'] if c.get('duration_minutes', 0) > 0], 'distances': [c['effort_distance_km'] for c in loc['checklist'] if c.get('effort_distance_km', 0) > 0]} for loc in locations], 'reportTaxa': report_taxa}
fixture['comments'] = [{'locality_id': loc['locality_id'], 'checklist_id': c['checklist_id'], 'date': c['date'], 'time': c['time'], 'duration_minutes': c.get('duration_minutes'), 'species_comments': [[t['code'], t['species_comment'].split('\nURN:CornellLabOfOrnithology:', 1)[0].strip()]  for t in c['species'] if t.get('species_comment')]} for loc in locations for c in loc['checklist'] if any(t.get('species_comment') for t in c['species'])]
args.output.write_text(json.dumps(fixture, ensure_ascii=False, separators=(',', ':')))
print(f'{len(stops)} stops; {len(checklists)} checklists; {len(locations)} EBD locations; {args.output.stat().st_size:,} bytes')
