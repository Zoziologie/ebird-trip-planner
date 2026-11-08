import { db } from '../data/db';
import { cloudUser, cloudBindings, bindCloudTrip } from '../state/cloudTrips';
import { readTripArchive } from './tripData';
import { encodeTripArchive } from './tripArchive';
import { readWorkspacePlan, prepareWorkspace, acknowledgePlan } from './workspaceLocal';
import { datasetArchive, samePlan, validatePlanSize } from './workspacePlan';
import { getWorkspaceCloud, createWorkspaceCloud } from './workspaceCloud';
import { saveCloudTrip } from './firebaseCloud';

// Upload source data once; subsequent edits use the compact plan sync coordinator.
export const enableTripCloud = async (tripId) => {
  await prepareWorkspace(tripId);
  const plan = await readWorkspacePlan(tripId);
  validatePlanSize(plan);
  if (!(await db.ebd.get(tripId))?.locations.length)
    throw new Error('Load eBird data for this trip before enabling cloud autosave.');
  const binding = cloudBindings.value[tripId];
  if (binding && binding.ownerUid !== cloudUser.value.uid)
    throw new Error('Only the owner can enable autosave for an older cloud trip.');
  let existing;
  try {
    existing = await getWorkspaceCloud(binding?.id || `${cloudUser.value.uid}_0`);
  } catch (error) {
    if (error.code === 'permission-denied')
      throw new Error(
        'Cloud autosave is not enabled on this server yet. Your device trip is kept.',
        { cause: error },
      );
    throw error;
  }
  if (binding && existing) return binding.id;
  const payload = await readTripArchive(tripId);
  const source = await saveCloudTrip(
    await encodeTripArchive(datasetArchive(payload)),
    { name: plan.name, localUpdatedAt: Number(payload.ebd?.updatedAt || 0), visitCount: 0 },
    binding || null,
  );
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
  const cloud = await createWorkspaceCloud(source.id, source.revision, plan, crypto.randomUUID());
  await db.workspaceSync.update(tripId, { cloudId: source.id, accountId: cloudUser.value.uid });
  if (samePlan(plan, cloud.plan)) await acknowledgePlan(tripId, cloud);
  else
    throw new Error(
      'A shared trip already exists. Open its editing link to reconcile your device copy.',
    );
  return source.id;
};
