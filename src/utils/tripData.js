import { db } from '../data/db';

// Read a consistent snapshot before exporting or uploading.
export const readTripArchive = (tripId) =>
  db.transaction(
    'r',
    db.trips,
    db.ebd,
    db.visits,
    db.lists,
    db.checklists,
    db.comments,
    db.workspaceReports,
    async () => {
      const [trip, ebd, visits, lists, checklists, comments] = await Promise.all([
        db.trips.get(tripId),
        db.ebd.get(tripId),
        db.visits.where('tripId').equals(tripId).toArray(),
        db.lists.where('tripId').equals(tripId).toArray(),
        db.checklists.where('tripId').equals(tripId).toArray(),
        db.comments.get(tripId),
      ]);
      const workspaceReport = trip.tripReportId
        ? await db.workspaceReports.get(trip.tripReportId)
        : null;
      return {
        workspaceReport,
        version: 3,
        exportedAt: new Date().toISOString(),
        trip,
        ebd,
        visits,
        lists,
        checklists,
        comments: comments?.entries || [],
      };
    },
  );

// Cloud files open as independent local copies; local file imports may replace a trip.
export const restoreTripArchive = async (
  payload,
  { asCopy = false, targetTripId = '', onProgress = () => {} } = {},
) => {
  const tripId = targetTripId || (asCopy ? crypto.randomUUID() : payload.trip.id);
  await db.transaction(
    'rw',
    db.trips,
    db.ebd,
    db.visits,
    db.lists,
    db.checklists,
    db.comments,
    db.workspaceReports,
    async () => {
      onProgress(0);
      // Early archives may omit timestamps; the trip library indexes updatedAt.
      await db.trips.put({
        ...payload.trip,
        id: tripId,
        createdAt: payload.trip.createdAt || Date.now(),
        updatedAt: payload.trip.updatedAt || Date.now(),
      });
      if (payload.workspaceReport) {
        const current = await db.workspaceReports.get(payload.workspaceReport.reportId);
        if (!current || payload.workspaceReport.updatedAt > current.updatedAt)
          await db.workspaceReports.put(payload.workspaceReport);
      }
      onProgress(1 / 6);
      if (payload.ebd) await db.ebd.put({ ...payload.ebd, tripId });
      else await db.ebd.delete(tripId);
      onProgress(2 / 6);
      await db.visits.where('tripId').equals(tripId).delete();
      // Visit numbers are browser-local, so imported numbers must never replace another trip's visits.
      await db.visits.bulkAdd(
        (payload.visits || []).map(({ id, ...visit }) => ({ ...visit, tripId })),
      );
      onProgress(3 / 6);
      await db.lists.where('tripId').equals(tripId).delete();
      await db.lists.bulkPut((payload.lists || []).map((list) => ({ ...list, tripId })));
      onProgress(4 / 6);
      await db.checklists.where('tripId').equals(tripId).delete();
      await db.checklists.bulkPut(
        (payload.checklists || []).map((entry) => ({ ...entry, tripId })),
      );
      onProgress(5 / 6);
      await db.comments.put({ tripId, entries: payload.comments || [] });
    },
  );
  onProgress(1);
  return tripId;
};
