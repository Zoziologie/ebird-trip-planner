<script setup>
import {
  computed,
  onMounted,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
  defineAsyncComponent,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { liveQuery } from 'dexie';
import { db, storeTripDataset } from '../data/db';
import { selectedTripId, refreshTrips } from '../state/tripSelection';
import { selectedVisitId } from '../state/visitSelection';
import {
  cloudConfigured,
  cloudUser,
  cloudReady,
  cloudBindings,
  bindCloudTrip,
} from '../state/cloudTrips';
import { workspaceStatus, workspaceReload, watchWorkspaceSync } from '../state/workspaceSync';
import { prepareWorkspace, readWorkspacePlan, applyWorkspacePlan } from '../utils/workspaceLocal';
import { enableTripCloud } from '../utils/tripCloudSetup';
import { getWorkspaceCloud, workspaceUrl } from '../utils/workspaceCloud';
import {
  initCloud,
  signInCloud,
  getCloudTrip,
  getCloudAccess,
  downloadCloudTrip,
  setCloudSharing,
  recordCloudActivity,
} from '../utils/firebaseCloud';
import { restoreTripArchive } from '../utils/tripData';
import { decodeTripArchive } from '../utils/tripArchive';
import TripWorkspaceView from '../components/TripWorkspaceView.vue';
import WorkspaceLoading from '../components/WorkspaceLoading.vue';
import { taxonomyByCode } from '../utils/taxonomy';
import { workspaceModel } from '../utils/workspaceModel';
import { tripTimeZone } from '../utils/tripTimeZone';
const Initiate = defineAsyncComponent(() => import('../components/Initiate.vue'));

const model = shallowRef(null);
let writes = Promise.resolve();
const loadModel = async (plan, tripId) => {
  const [ebd, comments, report] = await Promise.all([
    tripId ? db.ebd.get(tripId) : null,
    tripId ? db.comments.get(tripId) : null,
    plan.reportId ? db.workspaceReports.get(plan.reportId) : null,
  ]);
  model.value = workspaceModel(plan, ebd, comments?.entries || [], report, taxonomyByCode);
};
const savePlan = (plan) => {
  const tripId = selectedTripId.value;
  writes = writes
    .catch(() => {})
    .then(() =>
      db.transaction('rw', db.trips, db.visits, async () => {
        await applyWorkspacePlan(tripId, plan);
      }),
    );
  return writes.catch((failure) => {
    error.value = failure.message;
    throw failure;
  });
};
const saveReport = (report) => db.workspaceReports.put(report);
const addDataset = async (payload, onProgress) => {
  const tripId = selectedTripId.value;
  await db.transaction('rw', db.trips, db.ebd, db.checklists, db.comments, async () => {
    await storeTripDataset(tripId, payload);
    await db.trips.update(tripId, { updatedAt: Date.now() });
  });
  onProgress(1, 1, 'save steps');
  await loadModel(await readWorkspacePlan(tripId), tripId);
};
const saveLists = async (kind, taxa) => {
  const tripId = selectedTripId.value;
  const field = kind === 'life' ? 'liferWorld' : 'liferRegion';
  const ebd = await db.ebd.get(tripId);
  if (ebd)
    await db.ebd.update(tripId, {
      speciesList: ebd.speciesList.map((t) => ({
        ...t,
        [field]: taxa.get(t.code)?.[kind] ?? null,
      })),
    });
};
const route = useRoute();
const router = useRouter();
const ready = ref(false);
const loadingMessage = ref('Connecting to your trip…');
const busy = ref(false);
const error = ref('');
const localPlan = shallowRef(null);
const visitorPlan = shallowRef(null);
const state = ref(null);
const recoveries = ref([]);
const recovery = ref(null);
const sharing = ref(false);
const isPublic = ref(false);
const emails = ref('');
const sharingSaved = ref(false);
const publicLink = ref('');
const name = ref('');
const timeZone = ref('');
const timeZones = Intl.supportedValuesOf('timeZone');
const detectedTimeZone = computed(() => {
  const stop = localPlan.value?.stops[0];
  return stop ? tripTimeZone('', stop.latitude, stop.longitude) : '';
});
let subscription;
let sync;
let loadId = 0;
let initialized = false;
const cloudId = computed(() => (typeof route.query.cloud === 'string' ? route.query.cloud : ''));
const visitor = computed(() => Boolean(cloudId.value && route.query.edit !== '1'));
const binding = computed(() => cloudBindings.value[selectedTripId.value]);
const owner = computed(
  () => binding.value?.ownerUid === cloudUser.value?.uid && Boolean(cloudUser.value),
);
const waitingSignIn = computed(
  () => cloudId.value && !visitor.value && cloudReady.value && !cloudUser.value,
);
const contentKey = computed(() => `${selectedTripId.value}:${workspaceReload.value}`);
const download = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const run = async (action) => {
  busy.value = true;
  error.value = '';
  try {
    await action();
  } catch (failure) {
    error.value = failure.message;
  } finally {
    busy.value = false;
  }
};
const bindDataset = (tripId, trip) =>
  bindCloudTrip(tripId, {
    id: trip.id,
    revision: trip.revision,
    ownerUid: trip.ownerUid,
    accountId: cloudUser.value.uid,
    editable: true,
    savedAt: Date.now(),
    savedLocalEdit: 0,
    savedVisitCount: 0,
  });
const openSharedEditor = async (id) => {
  loadingMessage.value = 'Checking trip access…';
  const cloud = await getWorkspaceCloud(id);
  if (!cloud)
    throw new Error(
      'This trip has not been enabled for the new workspace yet. Open it from Trips first.',
    );
  const access = await getCloudAccess(id);
  if (
    access.ownerUid !== cloudUser.value.uid &&
    !access.editorEmails.includes(cloudUser.value.email.toLowerCase())
  )
    throw new Error('This account does not have editing access.');
  const existing = (await db.workspaceSync.where('cloudId').equals(id).toArray()).find(
    (item) => item.accountId === cloudUser.value.uid,
  );
  if (existing && (await db.trips.get(existing.tripId))) {
    await db.workspaceSync.update(existing.tripId, { accountId: cloudUser.value.uid });
    selectedTripId.value = existing.tripId;
    return;
  }
  const source = await getCloudTrip(id);
  loadingMessage.value = 'Downloading your trip…';
  const payload = await decodeTripArchive(await downloadCloudTrip(source));
  const tripId = await restoreTripArchive(payload, { asCopy: true });
  await prepareWorkspace(tripId);
  await db.transaction('rw', db.trips, db.visits, db.workspaceSync, async () => {
    await applyWorkspacePlan(tripId, cloud.plan);
    await db.workspaceSync.put({
      tripId,
      cloudId: id,
      accountId: cloudUser.value.uid,
      revision: cloud.revision,
      basePlan: cloud.plan,
      lastSavedAt: Date.now(),
    });
  });
  bindDataset(tripId, source);
  await refreshTrips();
  selectedVisitId.value = '';
  selectedTripId.value = tripId;
};
const attachLocal = async (tripId) => {
  subscription?.unsubscribe();
  sync?.stop();
  model.value = null;
  await writes;
  loadingMessage.value = 'Loading your trip data…';
  await prepareWorkspace(tripId);
  await loadModel(await readWorkspacePlan(tripId), tripId);
  subscription = liveQuery(async () => ({
    plan: await readWorkspacePlan(tripId),
    state: await db.workspaceSync.get(tripId),
    recoveries: await db.workspaceRecovery.where('tripId').equals(tripId).reverse().toArray(),
  })).subscribe((result) => {
    if (localPlan.value?.name !== result.plan.name) name.value = result.plan.name;
    if (localPlan.value?.timeZone !== result.plan.timeZone) timeZone.value = result.plan.timeZone;
    localPlan.value = result.plan;
    state.value = result.state;
    recoveries.value = result.recoveries;
  });
  sync = watchWorkspaceSync(tripId);
  loadingMessage.value = 'Checking for saved changes…';
  await sync.flush();
  const linked = await db.workspaceSync.get(tripId);
  if (navigator.onLine && linked?.cloudId && cloudUser.value?.uid === linked.accountId)
    await recordCloudActivity(linked.cloudId).catch((failure) => {
      error.value = `Trip opened from this device. Cloud connection failed: ${failure.message}`;
    });
};
const load = async () => {
  const request = ++loadId;
  ready.value = false;
  loadingMessage.value = cloudId.value ? 'Connecting to your trip…' : 'Loading your trip data…';
  error.value = '';
  subscription?.unsubscribe();
  sync?.stop();
  try {
    if (cloudId.value && !cloudConfigured)
      throw new Error('Cloud sharing is not configured in this build.');
    if (visitor.value) {
      // Anonymous views cache only the published projection, never source archives.
      if (navigator.onLine) {
        loadingMessage.value = 'Loading the shared trip…';
        const cloud = await getWorkspaceCloud(cloudId.value);
        if (!cloud) throw new Error('This workspace is unavailable.');
        visitorPlan.value = cloud.plan;
        await db.workspaceViews.put({ cloudId: cloudId.value, plan: cloud.plan });
      } else {
        visitorPlan.value = (await db.workspaceViews.get(cloudId.value))?.plan;
        if (!visitorPlan.value)
          throw new Error('Open this visitor link online once before using it offline.');
      }
      await loadModel(visitorPlan.value);
    } else {
      if (cloudId.value && !cloudUser.value) return;
      if (cloudId.value) {
        if (navigator.onLine) await openSharedEditor(cloudId.value);
        else {
          const cached = (
            await db.workspaceSync.where('cloudId').equals(cloudId.value).toArray()
          ).find((item) => item.accountId === cloudUser.value.uid);
          if (!cached) throw new Error('This trip has not been downloaded on this device.');
          selectedTripId.value = cached.tripId;
        }
      }
      await refreshTrips();
      if (selectedTripId.value) await attachLocal(selectedTripId.value);
    }
    if (request === loadId) ready.value = true;
  } catch (failure) {
    if (request === loadId) error.value = failure.message;
  }
};
const enableCloud = () =>
  run(async () => {
    const id = await enableTripCloud(selectedTripId.value);
    await router.push({ path: '/workspace', query: { cloud: id, edit: '1' } });
  });
const openSharing = () =>
  run(async () => {
    const source = await getCloudTrip(state.value.cloudId);
    const access = await getCloudAccess(state.value.cloudId);
    isPublic.value = source.public;
    emails.value = access.editorEmails.join('\n');
    sharingSaved.value = true;
    publicLink.value = source.public ? workspaceUrl(state.value.cloudId) : '';
    sharing.value = true;
  });
const saveSharing = () =>
  run(async () => {
    const editors = [
      ...new Set(
        emails.value
          .split(/[\n,;]+/)
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    if (editors.length > 10) throw new Error('Invite up to 10 Google accounts.');
    await setCloudSharing(state.value.cloudId, isPublic.value, editors);
    publicLink.value = isPublic.value ? workspaceUrl(state.value.cloudId) : '';
    sharingSaved.value = true;
  });
const rename = () =>
  run(async () => {
    await db.trips.update(selectedTripId.value, { name: name.value, updatedAt: Date.now() });
    await refreshTrips();
  });
const saveTimeZone = () =>
  run(async () => {
    timeZone.value = timeZone.value.trim();
    if (timeZone.value) new Intl.DateTimeFormat('en', { timeZone: timeZone.value });
    await db.trips.update(selectedTripId.value, {
      timeZone: timeZone.value,
      updatedAt: Date.now(),
    });
  });
const exportRecovery = (entry) =>
  download(
    new Blob([JSON.stringify({ version: 1, kind: 'workspace-recovery', ...entry }, null, 2)], {
      type: 'application/json',
    }),
    `trip-recovery-${entry.id}.json`,
  );
watch(workspaceReload, async () => {
  model.value = null;
  await loadModel(await readWorkspacePlan(selectedTripId.value), selectedTripId.value);
});
watch(() => route.fullPath, load);
// Handle initial auth before onMounted loads, rather than queuing a second download.
watch(
  () => cloudUser.value?.uid,
  () => {
    if (!initialized) return;
    if (waitingSignIn.value || (cloudId.value && !ready.value)) load();
    else sync?.flush();
  },
  { flush: 'sync' },
);
watch(selectedTripId, (id) => {
  if (ready.value && !cloudId.value && id) run(() => attachLocal(id));
});
onMounted(async () => {
  if (cloudConfigured) {
    await initCloud();
    if (!cloudReady.value)
      await new Promise((resolve) => {
        const stop = watch(cloudReady, (value) => {
          if (value) {
            stop();
            resolve();
          }
        });
      });
  }
  initialized = true;
  await load();
});
onBeforeUnmount(() => {
  loadId++;
  subscription?.unsubscribe();
  sync?.stop();
});
</script>

<template>
  <div class="workspace-page d-flex flex-column flex-grow-1 overflow-hidden">
    <div v-if="error" class="alert alert-warning m-2" role="alert">
      {{ error }} <button class="btn btn-sm btn-outline-secondary" @click="load">Retry</button>
    </div>
    <div v-if="waitingSignIn" class="p-4">
      <p>Sign in with an invited Google account to edit this trip.</p>
      <button class="btn btn-primary" @click="run(() => signInCloud())">Sign in with Google</button>
    </div>
    <template v-if="ready">
      <TripWorkspaceView
        v-if="visitor && model"
        :plan="visitorPlan"
        :model="model"
        :initial-view="route.query.view"
        visitor
        :save-report="saveReport"
      />
      <section
        v-else-if="selectedTripId && localPlan && model && !model.ebdLocations.length"
        class="p-4 overflow-auto"
      >
        <router-link to="/trips">My trips</router-link>
        <h1>{{ localPlan.name }}</h1>
        <h2>Add eBird data to start planning</h2>
        <p>
          This saved trip has no EBD dataset. Load one to continue; existing stops and notes are
          kept.
        </p>
        <Initiate :create-trip="addDataset" submit-label="Add eBird data" />
      </section>
      <template v-else-if="selectedTripId && localPlan && model">
        <div v-if="recoveries.length" class="alert alert-warning m-2 py-2" role="status">
          Device edits were preserved in {{ recoveries.length }} recovery
          {{ recoveries.length === 1 ? 'copy' : 'copies' }}.
          <button
            v-for="entry in recoveries"
            :key="entry.id"
            class="btn btn-link btn-sm"
            @click="recovery = entry"
          >
            Review {{ new Date(entry.createdAt).toLocaleString() }}
          </button>
        </div>
        <TripWorkspaceView
          :key="contentKey"
          :plan="localPlan"
          :model="model"
          :initial-view="route.query.view"
          :invited="Boolean(state?.cloudId) && !owner"
          :save="savePlan"
          :save-report="saveReport"
          :save-lists="saveLists"
        >
          <template #library
            ><router-link to="/trips" class="library-link" aria-label="My trips" title="My trips"
              ><i class="bi bi-grid" aria-hidden="true"></i></router-link
          ></template>
          <template #trip>
            <strong>{{ localPlan.name }}</strong>
          </template>
          <template #trip-options>
            <div class="trip-metadata">
              <label for="workspace-name">Trip name</label>
              <div class="settings-input-action">
                <input id="workspace-name" v-model="name" /><button
                  :disabled="busy"
                  aria-label="Save trip name"
                  @click="rename"
                >
                  Save
                </button>
              </div>
              <details>
                <summary>Advanced · time zone</summary>
                <p class="small">
                  Enter all stop times in local time at the destination. The trip clock uses the
                  first scheduled stop's time zone. Changing it keeps your entered times unchanged.
                </p>
                <p class="small">
                  {{
                    detectedTimeZone
                      ? `Detected: ${detectedTimeZone.replaceAll('_', ' ')}`
                      : 'Detected when you add the first stop.'
                  }}
                </p>
                <label for="workspace-time-zone">Time zone override (optional)</label>
                <div class="settings-input-action">
                  <input
                    id="workspace-time-zone"
                    v-model="timeZone"
                    list="workspace-time-zones"
                    placeholder="Automatic from first stop"
                  /><button :disabled="busy" aria-label="Save time zone" @click="saveTimeZone">
                    Save
                  </button>
                </div>
                <datalist id="workspace-time-zones">
                  <option v-for="zone in timeZones" :key="zone" :value="zone" />
                </datalist>
                <p class="small">
                  Leave blank and save to use automatic detection. Trips crossing time zones
                  currently use one trip clock.
                </p>
              </details>
            </div>
          </template>
          <template #actions>
            <span class="edit-only small" role="status">{{ workspaceStatus }}</span>
            <button
              v-if="!state?.cloudId && cloudConfigured && cloudUser"
              class="edit-only"
              :disabled="busy"
              @click="enableCloud"
            >
              Enable cloud autosave
            </button>
            <button
              v-if="!cloudUser && cloudConfigured"
              class="edit-only"
              @click="run(() => signInCloud())"
            >
              Sign in to sync
            </button>
            <button v-if="state?.cloudId" class="edit-only" :disabled="busy" @click="sync.flush()">
              Sync
            </button>
            <button v-if="state?.cloudId && owner" :disabled="busy" @click="openSharing">
              Share
            </button>
          </template>
        </TripWorkspaceView>
      </template>
      <div v-else class="p-4">
        <p>Create or import a trip to open the workspace.</p>
        <router-link to="/trips" class="btn btn-primary">My trips</router-link>
      </div>
    </template>
    <WorkspaceLoading
      v-if="
        !error &&
        !waitingSignIn &&
        (!ready || (selectedTripId && !visitor && (!localPlan || !model)))
      "
      :message="loadingMessage"
    />
    <dialog :open="sharing" class="workspace-dialog border rounded shadow" aria-label="Share trip">
      <h2 class="h5">Share trip</h2>
      <label class="form-check"
        ><input
          v-model="isPublic"
          type="checkbox"
          class="form-check-input"
          @change="sharingSaved = false"
        />
        Anyone with the link can view</label
      >
      <label for="workspace-editors" class="form-label mt-3">Invited editor Google emails</label>
      <textarea
        id="workspace-editors"
        v-model="emails"
        class="form-control"
        rows="3"
        @input="sharingSaved = false"
      />
      <button
        class="btn btn-primary btn-sm mt-2"
        :disabled="busy || sharingSaved"
        @click="saveSharing"
      >
        Save sharing settings
      </button>
      <template v-if="sharingSaved">
        <label v-if="publicLink" class="form-label d-block mt-3"
          >Visitor link<input
            :value="publicLink"
            readonly
            class="form-control"
            @focus="$event.target.select()"
        /></label>
        <label class="form-label d-block mt-3"
          >Editing link<input
            :value="workspaceUrl(state.cloudId, true)"
            readonly
            class="form-control"
            @focus="$event.target.select()"
        /></label>
      </template>
      <button class="btn btn-outline-secondary btn-sm mt-3" @click="sharing = false">Done</button>
    </dialog>
    <dialog
      :open="Boolean(recovery)"
      class="workspace-dialog border rounded shadow"
      aria-label="Recovery copy"
    >
      <template v-if="recovery"
        ><h2 class="h5">{{ recovery.name }}</h2>
        <p class="small">
          These edits are kept on this device. Reapply the changes you want to the shared trip, or
          download this copy for later.
        </p>
        <div class="recovery-stops">
          <div v-for="stop in recovery.plan.stops" :key="stop.id" class="border-bottom py-2">
            <strong>{{ stop.dateTime }} · {{ stop.name }}</strong>
            <div>
              {{ stop.type }} · {{ stop.durationMinutes }} min · {{ stop.latitude }},
              {{ stop.longitude }} · {{ stop.radiusMeters }} m
            </div>
            <p class="mb-0 text-break">{{ stop.note }}</p>
            <small>{{ stop.targetSpecies.join(', ') }}</small>
          </div>
        </div>
        <button class="btn btn-primary btn-sm mt-3" @click="exportRecovery(recovery)">
          Download recovery copy
        </button>
        <button class="btn btn-outline-secondary btn-sm mt-3 ms-2" @click="recovery = null">
          Close
        </button>
      </template>
    </dialog>
  </div>
</template>

<style scoped>
.workspace-page {
  min-height: 0;
}
.workspace-dialog {
  position: fixed;
  inset: 8vh 0 auto;
  margin: auto;
  width: min(600px, 94vw);
  max-height: 84vh;
  overflow: auto;
  z-index: 1055;
  padding: 1.5rem;
}
.recovery-stops {
  max-height: 45vh;
  overflow: auto;
}
</style>
