import { db } from '../data/db';
import { buildWorkspacePlan, workspaceVisits, samePlan, mergePlans } from './workspacePlan';

export const readWorkspacePlan = (tripId) =>
  db.transaction('r', db.trips, db.visits, async () =>
    buildWorkspacePlan(
      await db.trips.get(tripId),
      await db.visits.where('tripId').equals(tripId).toArray(),
    ),
  );

export const prepareWorkspace = (tripId) =>
  db.transaction('rw', db.trips, db.visits, db.workspaceSync, async () => {
    const visits = await db.visits.where('tripId').equals(tripId).toArray();
    for (const visit of visits)
      if (!visit.workspaceId)
        await db.visits.update(visit.id, { workspaceId: crypto.randomUUID() });
    if (!(await db.workspaceSync.get(tripId)))
      await db.workspaceSync.put({
        tripId,
        cloudId: '',
        accountId: '',
        revision: '',
        basePlan: null,
      });
  });

export const applyWorkspacePlan = async (tripId, plan) => {
  const previous = await db.visits.where('tripId').equals(tripId).toArray();
  const now = Date.now();
  await db.trips.update(tripId, {
    name: plan.name,
    timeZone: plan.timeZone,
    tripReportId: plan.reportId,
    updatedAt: now,
  });
  const before = new Map(buildWorkspacePlan({}, previous).stops.map((stop) => [stop.id, stop]));
  const ids = new Set(plan.stops.map((stop) => stop.id));
  const changed = plan.stops.filter((stop) => !samePlan(stop, before.get(stop.id)));
  await db.visits.bulkDelete(
    previous.filter((visit) => !ids.has(visit.workspaceId)).map((visit) => visit.id),
  );
  if (changed.length)
    await db.visits.bulkPut(workspaceVisits({ ...plan, stops: changed }, tripId, previous, now));
};

// The caller supplies server state. Device edits since the last sync are merged into
// it; only fields both sides changed are kept aside as a recovery copy.
export const acceptCloudPlan = (tripId, cloud) =>
  db.transaction('rw', db.trips, db.visits, db.workspaceSync, db.workspaceRecovery, async () => {
    const state = await db.workspaceSync.get(tripId);
    const local = await readWorkspacePlan(tripId);
    const { plan, conflicts } = mergePlans(state.basePlan, local, cloud.plan);
    let recoveryId = null;
    if (conflicts && !samePlan(local, state.basePlan)) {
      recoveryId = await db.workspaceRecovery.add({
        tripId,
        createdAt: Date.now(),
        baseRevision: state.revision,
        name: `${local.name} — recovered device edits`,
        plan: local,
      });
    }
    const changed = !samePlan(plan, local);
    if (changed) await applyWorkspacePlan(tripId, plan);
    await db.workspaceSync.put({
      ...state,
      revision: cloud.revision,
      basePlan: cloud.plan,
      pending: null,
      lastSavedAt: Date.now(),
    });
    // `unpublished`: merged device edits still need to be committed to the cloud.
    return { recoveryId, changed, unpublished: !samePlan(plan, cloud.plan) };
  });

export const acknowledgePlan = (tripId, cloud) =>
  db.transaction('rw', db.workspaceSync, async () => {
    const state = await db.workspaceSync.get(tripId);
    await db.workspaceSync.put({
      ...state,
      revision: cloud.revision,
      basePlan: cloud.plan,
      pending: null,
      lastSavedAt: Date.now(),
    });
  });
