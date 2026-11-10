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
  signOutCloud,
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
import { mergePlans, samePlan } from '../utils/workspacePlan';
import { tripTimeZone } from '../utils/tripTimeZone';
const Initiate = defineAsyncComponent(() => import('../components/Initiate.vue'));

const model = shallowRef(null);
const workspaceView = ref(null);
let writes = Promise.resolve();
// The device plan the editor's in-memory stops were last in step with. Sync can merge a
// collaborator's commit into IndexedDB underneath the editor; saves then merge against it
// instead of overwriting the collaborator's stops with the editor's stale copy.
let editorBase = null;
const buildModel = async (plan, tripId) => {
  const [ebd, comments, report] = await Promise.all([
    tripId ? db.ebd.get(tripId) : null,
    tripId ? db.comments.get(tripId) : null,
    plan.reportId ? db.workspaceReports.get(plan.reportId) : null,
  ]);
  return workspaceModel(plan, ebd, comments?.entries || [], report, taxonomyByCode);
};
const loadModel = async (plan, tripId) => {
  model.value = await buildModel(plan, tripId);
  editorBase = tripId ? plan : null;
};
const savePlan = (plan) => {
  const tripId = selectedTripId.value;
  const base = editorBase;
  writes = writes
    .catch(() => {})
    .then(() =>
      db.transaction('rw', db.trips, db.visits, async () => {
        const current = await readWorkspacePlan(tripId);
        const behind = base && !samePlan(current, base);
        // The editor's own edit wins over anything merged in since it last refreshed.
        await applyWorkspacePlan(
          tripId,
          behind ? mergePlans(base, plan, current, { prefer: 'local' }).plan : plan,
        );
        // Until the editor refreshes, its stops still match what it sent, not the merge.
        editorBase = behind ? plan : await readWorkspacePlan(tripId);
        if (behind) workspaceReload.value++;
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
const sharePublic = ref(false);
const shareOwnerEmail = ref('');
const shareEditors = ref([]);
const newEditor = ref('');
const shareStatus = ref('');
const shareError = ref('');
const copied = ref(false);
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
// One link per trip: signed-in owners and invited editors edit, everyone else views if public.
const visitor = ref(false);
const privateTrip = ref(false);
const binding = computed(() => cloudBindings.value[selectedTripId.value]);
const owner = computed(
  () => binding.value?.ownerUid === cloudUser.value?.uid && Boolean(cloudUser.value),
);
const shareLink = computed(() => (state.value?.cloudId ? workspaceUrl(state.value.cloudId) : ''));
const denied = (failure) => failure?.code === 'permission-denied';
const contentKey = computed(() => selectedTripId.value);
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
const canEdit = async (id) => {
  if (!cloudUser.value) return false;
  if (!navigator.onLine)
    return (await db.workspaceSync.where('cloudId').equals(id).toArray()).some(
      (item) => item.accountId === cloudUser.value.uid,
    );
  try {
    const access = await getCloudAccess(id);
    return (
      access?.ownerUid === cloudUser.value.uid ||
      Boolean(access?.editorEmails.includes(cloudUser.value.email.toLowerCase()))
    );
  } catch (failure) {
    if (denied(failure)) return false;
    throw failure;
  }
};
const openSharedEditor = async (id) => {
  const cloud = await getWorkspaceCloud(id);
  if (!cloud)
    throw new Error(
      'This trip has not been enabled for the new workspace yet. Open it from Trips first.',
    );
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
  privateTrip.value = false;
  subscription?.unsubscribe();
  sync?.stop();
  try {
    if (cloudId.value && !cloudConfigured)
      throw new Error('Cloud sharing is not configured in this build.');
    if (cloudId.value) {
      loadingMessage.value = 'Checking trip access…';
      const editing = await canEdit(cloudId.value);
      if (request !== loadId) return;
      visitor.value = !editing;
    } else visitor.value = false;
    if (visitor.value) {
      // Viewers cache only the published projection, never source archives.
      if (navigator.onLine) {
        loadingMessage.value = 'Loading the shared trip…';
        let cloud;
        try {
          cloud = await getWorkspaceCloud(cloudId.value);
        } catch (failure) {
          if (!denied(failure)) throw failure;
          if (request === loadId) privateTrip.value = true;
          return;
        }
        if (!cloud) throw new Error('This trip is unavailable.');
        visitorPlan.value = cloud.plan;
        await db.workspaceViews.put({ cloudId: cloudId.value, plan: cloud.plan });
      } else {
        visitorPlan.value = (await db.workspaceViews.get(cloudId.value))?.plan;
        if (!visitorPlan.value)
          throw new Error('Open this link online once before using it offline.');
      }
      await loadModel(visitorPlan.value);
    } else {
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
    await router.push({ path: '/workspace', query: { cloud: id } });
  });
const switchAccount = async () => {
  await signOutCloud();
  await signInCloud();
};
const maxEditors = 10;
const openSharing = () =>
  run(async () => {
    const [source, access] = await Promise.all([
      getCloudTrip(state.value.cloudId),
      getCloudAccess(state.value.cloudId),
    ]);
    sharePublic.value = source.public;
    shareOwnerEmail.value = access.ownerEmail || cloudUser.value?.email || '';
    shareEditors.value = access.editorEmails;
    newEditor.value = '';
    shareStatus.value = '';
    shareError.value = '';
    copied.value = false;
    sharing.value = true;
  });
// Every change is saved immediately, so the dialog never holds unsaved settings.
const saveSharing = async (isPublic, editors) => {
  busy.value = true;
  shareError.value = '';
  shareStatus.value = 'Saving…';
  try {
    await setCloudSharing(state.value.cloudId, isPublic, editors);
    sharePublic.value = isPublic;
    shareEditors.value = editors;
    shareStatus.value = 'Saved';
    return true;
  } catch (failure) {
    shareStatus.value = '';
    shareError.value = failure.message;
    return false;
  } finally {
    busy.value = false;
  }
};
const addEditor = async () => {
  const email = newEditor.value.trim().toLowerCase();
  shareError.value = '';
  if (!email) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return (shareError.value = 'Enter a full email address.');
  if (email === shareOwnerEmail.value.toLowerCase())
    return (shareError.value = 'You already own this trip.');
  if (shareEditors.value.includes(email)) return (shareError.value = `${email} can already edit.`);
  if (shareEditors.value.length >= maxEditors)
    return (shareError.value = `You can add up to ${maxEditors} people.`);
  if (await saveSharing(sharePublic.value, [...shareEditors.value, email])) newEditor.value = '';
};
const removeEditor = (email) =>
  saveSharing(
    sharePublic.value,
    shareEditors.value.filter((item) => item !== email),
  );
const setLinkAccess = (event) => saveSharing(event.target.value === 'public', shareEditors.value);
const copyLink = async () => {
  try {
    await navigator.clipboard.writeText(shareLink.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    shareError.value = 'Copy failed. Select the link and copy it manually.';
  }
};
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
// Show merged collaborator changes in place, keeping the map, selection and open panels.
let refreshing = Promise.resolve();
watch(workspaceReload, () => {
  refreshing = refreshing.then(async () => {
    const tripId = selectedTripId.value;
    if (!tripId || visitor.value) return;
    await writes.catch(() => {});
    const plan = await readWorkspacePlan(tripId);
    const view = workspaceView.value;
    if (view && model.value && plan.reportId === model.value.reportId) {
      const next = await buildModel(plan, tripId);
      if (tripId !== selectedTripId.value) return;
      // Re-read: an edit may have been saved while the model was being built.
      await writes.catch(() => {});
      const latest = await readWorkspacePlan(tripId);
      if (!samePlan(latest, plan)) return refreshAgain();
      if (!samePlan(view.getPlan(), plan)) view.replacePlan(next);
      editorBase = plan;
      return;
    }
    model.value = null;
    await loadModel(plan, tripId);
  });
});
const refreshAgain = () => workspaceReload.value++;
watch(() => route.fullPath, load);
// Handle initial auth before onMounted loads, rather than queuing a second download.
watch(
  () => cloudUser.value?.uid,
  () => {
    if (!initialized) return;
    // Signing in or out of a shared link can switch between viewing and editing.
    if (cloudId.value) load();
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
    <section v-if="privateTrip" class="p-4" role="alert">
      <h1 class="h5">This trip is private</h1>
      <template v-if="cloudUser">
        <p>
          {{ cloudUser.email }} hasn't been added to this trip. Ask the trip owner to add this
          Google account, or switch to the account they added.
        </p>
        <button class="btn btn-primary" :disabled="busy" @click="run(switchAccount)">
          Use another Google account
        </button>
      </template>
      <template v-else>
        <p>Sign in with the Google account the trip owner added.</p>
        <button class="btn btn-primary" :disabled="busy" @click="run(() => signInCloud())">
          Sign in with Google
        </button>
      </template>
      <router-link to="/trips" class="btn btn-link">My trips</router-link>
    </section>
    <template v-if="ready">
      <TripWorkspaceView
        v-if="visitor && model"
        :plan="visitorPlan"
        :model="model"
        :initial-view="route.query.view"
        visitor
        :save-report="saveReport"
      >
        <template v-if="!cloudUser" #actions>
          <button :disabled="busy" @click="run(() => signInCloud())">Sign in to edit</button>
        </template>
      </TripWorkspaceView>
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
          ref="workspaceView"
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
        !error && !privateTrip && (!ready || (selectedTripId && !visitor && (!localPlan || !model)))
      "
      :message="loadingMessage"
    />
    <dialog :open="sharing" class="workspace-dialog border rounded shadow" aria-label="Share trip">
      <h2 class="h5">Share trip</h2>
      <p class="small text-body-secondary mb-2">
        Everyone gets the same link. People you add below can edit; everyone else can only view it,
        and only if you allow it.
      </p>
      <div class="input-group">
        <input
          :value="shareLink"
          readonly
          class="form-control"
          aria-label="Trip link"
          @focus="$event.target.select()"
        />
        <button class="btn btn-primary" @click="copyLink">
          <i class="bi" :class="copied ? 'bi-check2' : 'bi-link-45deg'" aria-hidden="true"></i>
          {{ copied ? 'Copied' : 'Copy link' }}
        </button>
      </div>

      <label for="share-link-access" class="form-label fw-semibold mt-4 mb-1"
        >Who can open the link</label
      >
      <select
        id="share-link-access"
        class="form-select"
        :value="sharePublic ? 'public' : 'restricted'"
        :disabled="busy"
        @change="setLinkAccess"
      >
        <option value="restricted">Only people added below</option>
        <option value="public">Anyone with the link can view</option>
      </select>
      <p class="small text-body-secondary mt-1 mb-0">
        {{
          sharePublic
            ? 'No sign-in needed to view. Viewers see the stops, notes and target species, not your eBird data.'
            : 'Anyone else who opens the link is told the trip is private.'
        }}
      </p>

      <h3 class="form-label fw-semibold mt-4 mb-1 fs-6">People who can edit</h3>
      <ul class="list-group mb-2">
        <li class="list-group-item d-flex align-items-center gap-2">
          <span class="text-truncate flex-grow-1">{{ shareOwnerEmail }} (you)</span>
          <span class="small text-body-secondary">Owner</span>
        </li>
        <li
          v-for="email in shareEditors"
          :key="email"
          class="list-group-item d-flex align-items-center gap-2"
        >
          <span class="text-truncate flex-grow-1">{{ email }}</span>
          <button
            class="btn btn-sm btn-outline-danger"
            :disabled="busy"
            :aria-label="`Remove ${email}`"
            @click="removeEditor(email)"
          >
            Remove
          </button>
        </li>
      </ul>
      <form v-if="shareEditors.length < maxEditors" class="input-group" @submit.prevent="addEditor">
        <input
          v-model="newEditor"
          type="email"
          class="form-control"
          placeholder="name@gmail.com"
          aria-label="Google account email"
          autocomplete="off"
        />
        <button class="btn btn-outline-primary" :disabled="busy || !newEditor.trim()">Add</button>
      </form>
      <p class="small text-body-secondary mt-1">
        They open the link and sign in with this Google account. No email is sent, so send them the
        link yourself. Editors get a copy of the trip and its eBird data, but not your life lists.
        Up to {{ maxEditors }} people.
      </p>

      <div class="d-flex align-items-center gap-2 mt-3">
        <span v-if="shareError" class="small text-danger flex-grow-1" role="alert">{{
          shareError
        }}</span>
        <span v-else class="small text-body-secondary flex-grow-1" role="status">{{
          shareStatus
        }}</span>
        <button class="btn btn-outline-secondary btn-sm" @click="sharing = false">Done</button>
      </div>
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
