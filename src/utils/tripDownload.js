import { db } from '../data/db';
import { cloudUser, bindCloudTrip } from '../state/cloudTrips';
import { refreshTrips } from '../state/tripSelection';
import { getCloudTrip, getCloudAccess, downloadCloudTrip } from './firebaseCloud';
import { getWorkspaceCloud } from './workspaceCloud';
import { decodeTripArchive } from './tripArchive';
import { restoreTripArchive } from './tripData';
import { prepareWorkspace, applyWorkspacePlan } from './workspaceLocal';

// Saves a cloud trip on this device so it opens offline, or finds the copy already here.
// Returns the local trip id and whether anything was downloaded. `legacy` also accepts
// older cloud trips that have no workspace plan yet (opened as a plain dataset copy).
export async function saveCloudTripOnDevice(cloudId, { legacy = false, onDownload } = {}) {
  const cloud = await getWorkspaceCloud(cloudId, { legacy });
  if (!cloud && !legacy)
    throw new Error(
      'This trip has not been enabled for the new workspace yet. Open it from Trips first.',
    );
  const existing = (await db.workspaceSync.where('cloudId').equals(cloudId).toArray()).find(
    (item) => item.accountId === cloudUser.value.uid,
  );
  if (existing && (await db.trips.get(existing.tripId))) {
    await db.workspaceSync.update(existing.tripId, { accountId: cloudUser.value.uid });
    return { tripId: existing.tripId, downloaded: false };
  }
  onDownload?.();
  const source = await getCloudTrip(cloudId);
  const payload = await decodeTripArchive(await downloadCloudTrip(source));
  const tripId = await restoreTripArchive(payload, { asCopy: true });
  if (cloud) {
    await prepareWorkspace(tripId);
    await db.transaction('rw', db.trips, db.visits, db.workspaceSync, async () => {
      await applyWorkspacePlan(tripId, cloud.plan);
      await db.workspaceSync.put({
        tripId,
        cloudId,
        accountId: cloudUser.value.uid,
        revision: cloud.revision,
        basePlan: cloud.plan,
        lastSavedAt: Date.now(),
      });
    });
    bindCloudTrip(tripId, {
      id: source.id,
      revision: source.revision,
      ownerUid: source.ownerUid,
      accountId: cloudUser.value.uid,
      editable: true,
      savedAt: Date.now(),
      savedLocalEdit: 0,
      savedVisitCount: 0,
    });
  } else {
    // Keep older archived trips usable without overwriting a local trip or cloud file.
    const access = await getCloudAccess(cloudId);
    bindCloudTrip(tripId, {
      id: source.id,
      revision: source.revision,
      ownerUid: source.ownerUid,
      accountId: cloudUser.value.uid,
      editable:
        source.ownerUid === cloudUser.value.uid ||
        access.editorEmails.includes(cloudUser.value.email.toLowerCase()),
      savedAt: source.updatedAt?.toMillis() || 0,
    });
    // Opening prepares it too; doing it now gives the card its sync row right away.
    await prepareWorkspace(tripId);
  }
  await refreshTrips();
  return { tripId, downloaded: true };
}
