import { computed, ref } from 'vue';
import { selectedTripId } from './tripSelection';
import { liveQuery } from 'dexie';
import { db } from '../data/db';
import { cloudUser } from './cloudTrips';
import { samePlan } from '../utils/workspacePlan';
import { readWorkspacePlan, acceptCloudPlan, acknowledgePlan } from '../utils/workspaceLocal';
import { getWorkspaceCloud, publishWorkspacePlan } from '../utils/workspaceCloud';
import { workspaceReload } from './workspaceEvents';
export { workspaceReload } from './workspaceEvents';

export const workspaceStatuses = ref({});
export const workspaceStatus = computed(
  () => workspaceStatuses.value[selectedTripId.value] || 'Saved on this device',
);
const coordinators = new Map();
const retain = (entry) => {
  entry.users++;
  return {
    flush: entry.controller.flush,
    stop: () => {
      if (--entry.users === 0) {
        entry.controller.stop();
        coordinators.delete(entry.tripId);
      }
    },
  };
};

// One coordinator per mounted workspace. Web Locks serialize tabs on this device;
// cloud transactions serialize devices. IndexedDB remains the offline working copy.
export const watchWorkspaceSync = (tripId) => {
  if (coordinators.has(tripId)) return retain(coordinators.get(tripId));
  const status = (message) => {
    workspaceStatuses.value = { ...workspaceStatuses.value, [tripId]: message };
  };
  let timer;
  let stopped = false;
  let running = false;
  let again = false;
  const sync = async () => {
    const state = await db.workspaceSync.get(tripId);
    if (!state?.cloudId) {
      status('Saved on this device');
      return;
    }
    const local = await readWorkspacePlan(tripId);
    if (!navigator.onLine) {
      status(
        samePlan(local, state.basePlan)
          ? 'Offline · saved on this device'
          : 'Offline · changes saved on this device',
      );
      return;
    }
    if (cloudUser.value?.uid !== state.accountId) {
      status('Saved on this device · sign in to sync');
      return;
    }
    status('Syncing…');
    const cloud = await getWorkspaceCloud(state.cloudId);
    if (!cloud) throw new Error('The shared trip is unavailable. Device changes are kept.');
    if (state.pending && cloud.commitId === state.pending.commitId) {
      await acknowledgePlan(tripId, cloud);
      again = true;
      return;
    }
    if (cloud.revision !== state.revision) {
      await acceptCloudPlan(tripId, cloud);
      workspaceReload.value++;
      status('Cloud version opened · check recovery copies for device edits');
      return;
    }
    if (samePlan(local, state.basePlan)) {
      status('Saved to cloud');
      return;
    }
    const pending = state.pending || { commitId: crypto.randomUUID(), plan: local };
    await db.workspaceSync.update(tripId, { pending });
    const saved = await publishWorkspacePlan(
      state.cloudId,
      state.revision,
      pending.commitId,
      pending.plan,
    );
    if (saved.conflict) {
      await acceptCloudPlan(tripId, saved);
      workspaceReload.value++;
      status('Device edits preserved in recovery copies');
    } else {
      await acknowledgePlan(tripId, saved);
      status('Saved to cloud');
      // Edits made during the request belong to the next commit, not this one.
      again = !samePlan(await readWorkspacePlan(tripId), saved.plan);
    }
  };
  const flush = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        if (navigator.locks) await navigator.locks.request(`workspace-sync:${tripId}`, sync);
        else await sync();
      } while (again && !stopped);
    } catch (error) {
      status(`Saved on this device · ${error.message}`);
    } finally {
      running = false;
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, 1200);
  };
  const subscription = liveQuery(() => readWorkspacePlan(tripId)).subscribe({
    next: schedule,
    error: (error) => {
      status(`Device save error: ${error.message}`);
    },
  });
  window.addEventListener('online', flush);
  window.addEventListener('offline', flush);
  window.addEventListener('focus', flush);
  const interval = setInterval(flush, 20000);
  const controller = {
    flush,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(interval);
      subscription.unsubscribe();
      window.removeEventListener('online', flush);
      window.removeEventListener('offline', flush);
      window.removeEventListener('focus', flush);
    },
  };
  const entry = { tripId, users: 0, controller };
  coordinators.set(tripId, entry);
  return retain(entry);
};
