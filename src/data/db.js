import Dexie from 'dexie';

// Workspace schema 4 is additive; it does not change the v3 export format.
//
// Keep schema 3 and add workspace tables without replacing existing records.
// Legacy dataset shapes are preserved; workspace migration normalizes only plans.
export const db = new Dexie('ebirdTripPlanner_v1');

// `ebd` is one row per trip and every page loads it whole, so only aggregates
// live there. The other two tables hold what is large and rarely read:
//   `checklists` - per-location raw checklists (~105 MB for a state-sized trip),
//     read when a map popup or the KML export needs one location.
//   `comments`   - every checklist and species comment in the trip, in one row,
//     read only when someone exports comments. Keeping it out of `checklists`
//     is what lets "every note about this species" avoid reading thousands of
//     localities. See tests/perf/README.md.
db.version(3).stores({
  trips: 'id, name, updatedAt',
  ebd: 'tripId, updatedAt',
  lists: '[tripId+kind], tripId, kind',
  visits: '++id, tripId, dateTime',
  checklists: '[tripId+localityId], tripId',
  comments: 'tripId',
});

// Additive workspace migration: existing trips and large source tables stay intact.
db.version(4).stores({
  workspaceSync: 'tripId, cloudId',
  workspaceRecovery: '++id, tripId, createdAt',
  workspaceViews: 'cloudId',
});

db.version(5).stores({ workspaceReports: 'reportId' });

db.visits.hook('creating', (key, visit) => {
  if (!visit.workspaceId) visit.workspaceId = crypto.randomUUID();
});

// Called inside the caller's trip transaction, before opening the planner.
export const storeTripDataset = async (tripId, payload) => {
  if (!payload.locations.length)
    throw new Error('No eBird locations match these filters. Adjust the filters and try again.');
  await db.ebd.put({
    tripId,
    speciesList: payload.speciesList,
    locations: payload.locations,
    region: payload.region,
    filters: payload.filters,
    updatedAt: Date.now(),
  });
  await db.checklists.bulkPut(
    payload.checklists.map((entry) => ({
      tripId,
      localityId: String(entry.localityId),
      checklist: entry.checklist,
    })),
  );
  await db.comments.put({ tripId, entries: payload.comments });
};
