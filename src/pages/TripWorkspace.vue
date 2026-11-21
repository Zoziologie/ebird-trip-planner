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
  cloudLibrary,
  bindCloudTrip,
} from '../state/cloudTrips';
import { workspaceStatus, workspaceReload, watchWorkspaceSync } from '../state/workspaceSync';
import {
  prepareWorkspace,
  readWorkspacePlan,
  applyWorkspacePlan,
  recoveryRetentionMs,
} from '../utils/workspaceLocal';
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
import {
  restoreTripArchive,
  readLocationChecklists,
  readLocationDistances,
} from '../utils/tripData';
import { decodeTripArchive } from '../utils/tripArchive';
import TripWorkspaceView from '../components/TripWorkspaceView.vue';
import WorkspaceLoading from '../components/WorkspaceLoading.vue';
import AppAlert from '../components/AppAlert.vue';
import { taxonomyByCode } from '../utils/taxonomy';
import { workspaceModel } from '../utils/workspaceModel';
import { mergePlans, samePlan } from '../utils/workspacePlan';
import { readPersonalLists, preparePersonalLists, savePersonalList } from '../utils/personalLists';
import { tripTimeZone } from '../utils/tripTimeZone';
import { findTripByName, tripCloudId } from '../utils/tripNames';
const Initiate = defineAsyncComponent(() => import('../components/Initiate.vue'));

const model = shallowRef(null);
const workspaceView = ref(null);
let writes = Promise.resolve();
// The device plan the editor's in-memory stops were last in step with. Sync can merge a
// collaborator's commit into IndexedDB underneath the editor; saves then merge against it
// instead of overwriting the collaborator's stops with the editor's stale copy.
let editorBase = null;
const buildModel = async (plan, tripId) => {
  const [ebd, comments, report, lists] = await Promise.all([
    tripId ? db.ebd.get(tripId) : null,
    tripId ? db.comments.get(tripId) : null,
    plan.reportId ? db.workspaceReports.get(plan.reportId) : null,
    tripId ? readPersonalLists(tripId) : [],
  ]);
  return workspaceModel(plan, ebd, comments?.entries || [], report, taxonomyByCode, lists);
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
const loadLocationDistances = (ids) => readLocationDistances(selectedTripId.value, ids);
const loadLocationChecklists = (id) => readLocationChecklists(selectedTripId.value, id);
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
const saveLists = (kind, taxa) => savePersonalList(selectedTripId.value, kind, taxa);
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
const recoveryNoticeHidden = ref(false);
const sharing = ref(false);
// Both dialogs open as real modals so they get the shared blurred backdrop and Escape closes them.
const shareDialog = ref(null),
  recoveryDialog = ref(null);
const syncModal = (dialog, open) => {
  if (!dialog) return;
  if (open && !dialog.open) dialog.showModal();
  else if (!open && dialog.open) dialog.close();
};
watch(sharing, (open) => syncModal(shareDialog.value, open));
watch(recovery, (entry) => syncModal(recoveryDialog.value, Boolean(entry)));
const sharePublic = ref(false);
const shareOwnerEmail = ref('');
const shareEditors = ref([]);
const newEditor = ref('');
const shareStatus = ref('');
const shareError = ref('');
const copied = ref(false);
const name = ref('');
const nameError = ref('');
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
  () =>
    Boolean(cloudUser.value) &&
    (cloudLibrary.value.find((trip) => trip.id === state.value?.cloudId)?.ownerUid ||
      binding.value?.ownerUid) === cloudUser.value.uid,
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
  await preparePersonalLists(tripId);
  await loadModel(await readWorkspacePlan(tripId), tripId);
  subscription = liveQuery(async () => ({
    plan: await readWorkspacePlan(tripId),
    lists: await readPersonalLists(tripId),
    state: await db.workspaceSync.get(tripId),
    recoveries: await db.workspaceRecovery.where('tripId').equals(tripId).reverse().toArray(),
  })).subscribe((result) => {
    if (localPlan.value?.name !== result.plan.name) name.value = result.plan.name;
    if (localPlan.value?.timeZone !== result.plan.timeZone) timeZone.value = result.plan.timeZone;
    workspaceView.value?.setPersonalLists(result.lists);
    localPlan.value = result.plan;
    state.value = result.state;
    recoveries.value = result.recoveries;
  });
  sync = watchWorkspaceSync(tripId);
  loadingMessage.value = 'Checking for saved changes…';
  await sync.flush();
  await loadModel(await readWorkspacePlan(tripId), tripId);
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
const setLinkAccess = async (event) => {
  await saveSharing(event.target.checked, shareEditors.value);
  event.target.checked = sharePublic.value;
};
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
    name.value = name.value.trim();
    const local = await db.trips.toArray();
    const current = { id: selectedTripId.value, sync: state.value };
    const currentCloudId = tripCloudId(current, cloudBindings.value);
    const others = [
      ...local.filter((trip) => trip.id !== selectedTripId.value),
      ...cloudLibrary.value.filter((trip) => trip.revision && trip.id !== currentCloudId),
    ];
    nameError.value = '';
    if (!name.value || findTripByName(others, name.value)) {
      nameError.value = 'Choose a different trip name; this name is already used.';
      return;
    }
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
const deleteRecovery = () =>
  run(async () => {
    await db.workspaceRecovery.delete(recovery.value.id);
    recovery.value = null;
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
    else if (selectedTripId.value) load();
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
    <AppAlert v-if="error" tone="danger" class="m-2" @close="error = ''">
      {{ error }} <button class="btn btn-link btn-sm" @click="load">Retry</button>
    </AppAlert>
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
        <AppAlert
          v-if="recoveries.length && !recoveryNoticeHidden"
          tone="warning"
          class="recovery-notice m-2"
          @close="recoveryNoticeHidden = true"
        >
          <div class="recovery-notice-content">
            <span>
              {{ recoveries.length }} local recovery
              {{ recoveries.length === 1 ? 'copy' : 'copies' }} · kept 14 days.
            </span>
            <select
              class="form-select form-select-sm w-auto"
              aria-label="Local recovery copies"
              :value="recovery?.id || ''"
              @change="
                recovery = recoveries.find((entry) => entry.id === Number($event.target.value))
              "
            >
              <option value="" disabled>Review a copy…</option>
              <option v-for="entry in recoveries" :key="entry.id" :value="entry.id">
                #{{ entry.id }} · {{ new Date(entry.createdAt).toLocaleString() }}
              </option>
            </select>
          </div>
        </AppAlert>
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
          :load-checklists="loadLocationChecklists"
          :load-distances="loadLocationDistances"
        >
          <template #library
            ><router-link to="/trips" class="library-link" aria-label="My trips" title="My trips"
              ><i class="bi bi-grid" aria-hidden="true"></i></router-link
          ></template>
          <template #trip>
            <strong>{{ localPlan.name }}</strong>
          </template>
          <template #trip-options>
            <div class="trip-metadata settings-inline-row">
              <label for="workspace-name">Trip name</label>
              <div class="settings-input-action">
                <input
                  id="workspace-name"
                  v-model="name"
                  aria-describedby="workspace-name-error"
                  @input="nameError = ''"
                /><button :disabled="busy" aria-label="Save trip name" @click="rename">Save</button>
              </div>
            </div>
            <p v-if="nameError" id="workspace-name-error" class="small text-danger" role="alert">
              {{ nameError }}
            </p>
          </template>
          <template #time-zone>
            <details class="timezone-settings">
              <summary>
                <span><i class="bi bi-clock" aria-hidden="true"></i> Time zone</span
                ><span class="small">{{
                  timeZone || detectedTimeZone?.replaceAll('_', ' ') || 'Automatic'
                }}</span>
              </summary>
              <div class="settings-input-action">
                <input
                  id="workspace-time-zone"
                  v-model="timeZone"
                  list="workspace-time-zones"
                  aria-label="Time zone override"
                  :placeholder="detectedTimeZone || 'Automatic from first stop'"
                />
                <button :disabled="busy" aria-label="Save time zone" @click="saveTimeZone">
                  Save
                </button>
              </div>
              <datalist id="workspace-time-zones">
                <option v-for="zone in timeZones" :key="zone" :value="zone" />
              </datalist>
              <p class="small">
                One clock for the trip; stop times stay unchanged. Leave blank for automatic
                detection.
              </p>
            </details>
          </template>
          <template #actions>
            <span class="edit-only small" role="status">{{ workspaceStatus }}</span>
            <button
              v-if="!state?.cloudId && cloudConfigured && cloudUser"
              class="edit-only"
              :disabled="busy"
              @click="enableCloud"
            >
              <i class="bi bi-cloud-arrow-up" aria-hidden="true"></i> Enable cloud autosave
            </button>
            <button v-if="!cloudUser && cloudConfigured" @click="run(() => signInCloud())">
              <i class="bi bi-box-arrow-in-right" aria-hidden="true"></i> Sign in to sync
            </button>
            <button
              v-if="state?.cloudId && owner"
              class="header-action"
              :disabled="busy"
              @click="openSharing"
            >
              <i class="bi bi-share" aria-hidden="true"></i><span>Share</span>
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
    <dialog
      ref="shareDialog"
      class="workspace-dialog share-dialog"
      aria-labelledby="share-title"
      @close="sharing = false"
    >
      <h2 id="share-title">Share your trip</h2>
      <div class="share-input-row">
        <input :value="shareLink" readonly aria-label="Trip link" @focus="$event.target.select()" />
        <button class="share-button" @click="copyLink">
          <i class="bi" :class="copied ? 'bi-check2' : 'bi-copy'" aria-hidden="true"></i>
          Copy link
        </button>
      </div>

      <div class="share-public">
        <input
          id="share-link-access"
          type="checkbox"
          :checked="sharePublic"
          :disabled="busy"
          aria-describedby="share-public-help"
          @change="setLinkAccess"
        />
        <div>
          <label for="share-link-access">Public trip</label>
          <p id="share-public-help">
            Anyone with the link can preview your trip. Only editors can modify it.
          </p>
        </div>
      </div>

      <section class="share-editors" aria-labelledby="share-editors-title">
        <h3 id="share-editors-title">Editors</h3>
        <p>Adding someone’s Google email address gives them edit access.</p>
        <form
          v-if="shareEditors.length < maxEditors"
          class="share-input-row"
          @submit.prevent="addEditor"
        >
          <input
            v-model="newEditor"
            type="email"
            placeholder="name@gmail.com"
            aria-label="Google account email"
            autocomplete="off"
          />
          <button class="share-button" :disabled="busy || !newEditor.trim()">
            <i class="bi bi-person-plus" aria-hidden="true"></i>
            Add editor
          </button>
        </form>
        <ul class="share-people">
          <li>
            <span>{{ shareOwnerEmail }}</span>
            <small>Owner (you)</small>
          </li>
          <li v-for="email in shareEditors" :key="email">
            <span>{{ email }}</span>
            <button
              class="share-remove"
              :disabled="busy"
              :aria-label="`Remove ${email}`"
              @click="removeEditor(email)"
            >
              <i class="bi bi-x-lg" aria-hidden="true"></i>
            </button>
          </li>
        </ul>
      </section>

      <details class="share-details">
        <summary>Details</summary>
        <ul>
          <li>Only Google accounts can be added as editors.</li>
          <li>Access is immediate. There is nothing to accept and no notification is sent.</li>
          <li>Editors must sign in with their Google account to open and edit the trip.</li>
          <li>The same link above works for editing. Send it to your editors.</li>
          <li>Your life and regional target lists stay personal and are not shared.</li>
        </ul>
      </details>

      <div class="share-footer">
        <span v-if="shareError" class="text-danger" role="alert">{{ shareError }}</span>
        <span v-else role="status">{{ shareStatus }}</span>
        <button class="share-button" @click="sharing = false">Done</button>
      </div>
    </dialog>
    <dialog
      ref="recoveryDialog"
      class="workspace-dialog border rounded shadow"
      @close="recovery = null"
      aria-label="Recovery copy"
    >
      <template v-if="recovery"
        ><h2 class="h5">{{ recovery.name }}</h2>
        <p class="small">
          Local to this device. Expires
          {{ new Date(recovery.createdAt + recoveryRetentionMs).toLocaleDateString() }}. Download to
          keep it.
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
          <i class="bi bi-download" aria-hidden="true"></i> Download recovery copy
        </button>
        <button
          class="btn btn-outline-danger btn-sm mt-3 ms-2"
          :disabled="busy"
          @click="deleteRecovery"
        >
          <i class="bi bi-trash" aria-hidden="true"></i> Delete copy
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
.share-dialog {
  border: 1px solid #d6e1dd;
  border-radius: 8px;
  background: #fbfcfa;
  color: #303b3c;
  box-shadow: 0 12px 40px #19333826;
  font-size: 14px;
}
.share-dialog::backdrop {
  background: #19333855;
}
.share-dialog h2 {
  margin: 0 0 20px;
  font-size: 22px;
  font-weight: 600;
}
.share-dialog h3 {
  margin: 0 0 6px;
  font-size: 16px;
  font-weight: 600;
}
.share-dialog p {
  margin: 0 0 12px;
  color: #596968;
  line-height: 1.5;
}
.share-input-row {
  display: flex;
  gap: 8px;
}
.share-input-row input {
  min-width: 0;
  flex: 1;
  padding: 9px 10px;
  border: 1px solid #cbd8d4;
  border-radius: 4px;
  background: white;
  color: inherit;
  font: inherit;
}
.share-input-row input:focus-visible {
  outline: 2px solid #386d70;
  outline-offset: 1px;
}
.share-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 9px 12px;
  border: 1px solid #386d70;
  border-radius: 4px;
  background: #386d70;
  color: white;
  font: inherit;
  white-space: nowrap;
}
.share-button:hover {
  background: #2d5c5f;
}
.share-button:disabled {
  opacity: 0.5;
}
.share-public {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 22px 0;
}
.share-public input {
  margin-top: 4px;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  accent-color: #386d70;
}
.share-public label {
  font-weight: 600;
}
.share-public p {
  margin: 3px 0 0;
}
.share-editors {
  border-top: 1px solid #d6e1dd;
  padding-top: 20px;
}
.share-people {
  list-style: none;
  padding: 0;
  margin: 12px 0 20px;
}
.share-people li {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 38px;
}
.share-people li > span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.share-people small {
  color: #596968;
  white-space: nowrap;
}
.share-remove {
  border: 0;
  border-radius: 4px;
  padding: 8px;
  background: transparent;
  color: #596968;
}
.share-remove:hover {
  background: #f8e0de;
  color: #b6413a;
}
.share-details {
  color: #596968;
  font-size: 13px;
}
.share-details summary {
  color: #386d70;
}
.share-details ul {
  padding-left: 20px;
  margin: 10px 0 0;
  line-height: 1.6;
}
.share-details li + li {
  margin-top: 5px;
}
.share-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid #d6e1dd;
}
.share-footer > span {
  flex: 1;
  font-size: 13px;
  color: #596968;
}
@media (max-width: 480px) {
  .share-dialog {
    padding: 18px;
  }
  .share-input-row .share-button {
    min-height: 44px;
  }
}
.recovery-notice {
  align-items: center;
}
.recovery-notice-content {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.recovery-notice-content select {
  min-width: 0;
  max-width: 100%;
}
.recovery-notice :deep(.app-alert-close) {
  margin: 0;
}
.recovery-stops {
  max-height: 45vh;
  overflow: auto;
}
</style>
