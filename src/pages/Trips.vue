<script setup>
import {
  computed,
  ref,
  shallowRef,
  onMounted,
  onBeforeUnmount,
  watch,
  defineAsyncComponent,
  nextTick,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { liveQuery } from 'dexie';
import { db, storeTripDataset } from '../data/db';
import { trips, selectedTripId, refreshTrips } from '../state/tripSelection';
import {
  cloudConfigured,
  cloudUser,
  cloudReady,
  cloudLibrary,
  cloudBindings,
  cloudError,
  cloudAllowance,
  bindCloudTrip,
} from '../state/cloudTrips';
import {
  initCloud,
  signInCloud,
  signOutCloud,
  getCloudTrip,
  getCloudAccess,
  downloadCloudTrip,
  deleteCloudTrip,
} from '../utils/firebaseCloud';
import { getWorkspaceCloud } from '../utils/workspaceCloud';
import { workspaceVisits } from '../utils/workspacePlan';
import { prepareWorkspace } from '../utils/workspaceLocal';
import { enableTripCloud } from '../utils/tripCloudSetup';
import { readTripArchive, restoreTripArchive } from '../utils/tripData';
import { encodeTripArchive, decodeTripArchive, tripArchiveName } from '../utils/tripArchive';
import { uniqueTripName } from '../utils/tripNames';
import WorkspaceLoading from '../components/WorkspaceLoading.vue';
import AppAlert from '../components/AppAlert.vue';
import zoziologieLogo from '../assets/zoziologie-logo.svg';
import { tripDates } from '../utils/tripDates';
const Initiate = defineAsyncComponent(() => import('../components/Initiate.vue'));

const router = useRouter(),
  route = useRoute();
const cloudPlans = shallowRef({});
watch(cloudLibrary, (items, previous, onCleanup) => {
  let active = true;
  onCleanup(() => {
    active = false;
  });
  cloudPlans.value = {};
  Promise.all(
    items
      .filter((item) => item.revision)
      .map(async (item) => [item.id, (await getWorkspaceCloud(item.id, { legacy: true }))?.plan]),
  )
    .then((entries) => {
      if (active) cloudPlans.value = Object.fromEntries(entries);
    })
    .catch((failure) => {
      if (active) error.value = failure.message;
    });
});
const rows = ref([]),
  busy = ref(false),
  opening = ref(''),
  error = ref(''),
  status = ref(''),
  online = ref(navigator.onLine);
const mode = ref(''),
  name = ref(''),
  saveOnline = ref(true);
const importing = ref(false),
  progress = ref(''),
  pendingImport = shallowRef(null),
  removal = ref(null);
const createDialog = ref(null),
  removeDialog = ref(null),
  tripFilePicker = ref(null);
const version = __APP_VERSION__;
const now = ref(new Date());
const clock = setInterval(() => (now.value = new Date()), 60000);
const subscription = liveQuery(async () => {
  const local = await db.trips.orderBy('updatedAt').reverse().toArray();
  return Promise.all(
    local.map(async (trip) => {
      const visits = await db.visits.where('tripId').equals(trip.id).toArray();
      return {
        ...trip,
        stopCount: visits.length,
        visits,
        sync: await db.workspaceSync.get(trip.id),
      };
    }),
  );
}).subscribe((value) => {
  rows.value = value;
  trips.value = value;
});
onBeforeUnmount(() => {
  subscription.unsubscribe();
  clearInterval(clock);
});
const names = computed(() => [
  ...rows.value,
  ...cloudLibrary.value.filter((trip) => trip.revision),
]);
const duplicate = computed(() =>
  names.value.some((trip) => trip.name.trim().toLowerCase() === name.value.trim().toLowerCase()),
);
const library = computed(() => {
  const linked = new Set(rows.value.map((trip) => cloudBindings.value[trip.id]?.id));
  return [
    ...rows.value.map((trip) => ({
      ...trip,
      dates: tripDates(trip.visits, trip.timeZone, now.value),
      localId: trip.id,
      cloudId: cloudBindings.value[trip.id]?.id || '',
      cloud: cloudLibrary.value.find((item) => item.id === cloudBindings.value[trip.id]?.id),
    })),
    ...cloudLibrary.value
      .filter((trip) => trip.revision && !linked.has(trip.id))
      .map((trip) => ({
        ...trip,
        name: cloudPlans.value[trip.id]?.name || trip.name,
        stopCount: cloudPlans.value[trip.id]?.stops.length,
        dates: cloudPlans.value[trip.id]
          ? tripDates(
              cloudPlans.value[trip.id].stops,
              cloudPlans.value[trip.id].timeZone,
              now.value,
            )
          : { group: 'undated', label: 'Dates unavailable' },
        timeZone: cloudPlans.value[trip.id]?.timeZone,
        localId: '',
        cloudId: trip.id,
        cloud: trip,
      })),
  ];
});
const groups = computed(() =>
  [
    { id: 'current', title: 'Current' },
    { id: 'upcoming', title: 'Coming up' },
    { id: 'past', title: 'Past' },
    { id: 'undated', title: 'Dates unavailable' },
  ].map((group) => ({
    ...group,
    trips: library.value.filter((trip) => trip.dates.group === group.id),
  })),
);
const run = async (action) => {
  busy.value = true;
  error.value = '';
  status.value = '';
  try {
    await action();
  } catch (failure) {
    error.value = failure.message;
    status.value = '';
  } finally {
    busy.value = false;
  }
};
const connection = (item) =>
  item.sync?.cloudId
    ? online.value
      ? 'Cloud autosave'
      : 'Offline · saved on device'
    : item.cloudId
      ? 'Cloud trip'
      : 'On this device';
const start = (kind) => {
  mode.value = kind;
  name.value = '';
  pendingImport.value = null;
  progress.value = '';
  error.value = '';
  createDialog.value.showModal();
};
const openLocal = async (id) => {
  opening.value = 'Preparing your saved trip…';
  await prepareWorkspace(id);
  await refreshTrips();
  selectedTripId.value = id;
  await router.push('/workspace');
};
const open = (item) => {
  opening.value = item.localId ? 'Preparing your saved trip…' : 'Connecting to your cloud trip…';
  return run(async () => {
    try {
      if (item.localId) return await openLocal(item.localId);
      if (await getWorkspaceCloud(item.cloudId, { legacy: true }))
        return await router.push({ path: '/workspace', query: { cloud: item.cloudId } });
      // Keep older archived trips usable without overwriting a local trip or cloud file.
      opening.value = 'Downloading your trip…';
      const source = await getCloudTrip(item.cloudId);
      const access = await getCloudAccess(item.cloudId);
      const payload = await decodeTripArchive(await downloadCloudTrip(source));
      const id = await restoreTripArchive(payload, { asCopy: true });
      bindCloudTrip(id, {
        id: source.id,
        revision: source.revision,
        ownerUid: source.ownerUid,
        accountId: cloudUser.value.uid,
        editable:
          source.ownerUid === cloudUser.value.uid ||
          access.editorEmails.includes(cloudUser.value.email.toLowerCase()),
        savedAt: source.updatedAt?.toMillis() || 0,
      });
      await openLocal(id);
    } finally {
      opening.value = '';
    }
  });
};
const finishNew = async (id) => {
  selectedTripId.value = id;
  await prepareWorkspace(id);
  await refreshTrips();
  if (
    cloudUser.value &&
    saveOnline.value &&
    online.value &&
    (await db.ebd.get(id))?.locations.length
  ) {
    try {
      await enableTripCloud(id);
    } catch (failure) {
      createDialog.value.close();
      error.value = `Trip saved on this device. Cloud setup failed: ${failure.message}`;
      return;
    }
  }
  createDialog.value.close();
  await openLocal(id);
};
const create = async (payload, onProgress = () => {}) => {
  const id = crypto.randomUUID(),
    now = Date.now();
  await db.transaction('rw', db.trips, db.ebd, db.checklists, db.comments, async () => {
    await db.trips.put({
      id,
      name: name.value.trim(),
      timeZone: '',
      tripReportId: '',
      createdAt: now,
      updatedAt: now,
    });
    await storeTripDataset(id, payload);
  });
  onProgress(1, 1, 'save steps');
  await finishNew(id);
};
// The name field is usable while the trip file is still being read; the trip's saved name only
// replaces the file-based guess if the person has not typed their own.
let nameTouched = false,
  loadToken = 0;
const loadTripFile = async (file) => {
  if (!file) return;
  const token = ++loadToken;
  importing.value = true;
  error.value = '';
  pendingImport.value = null;
  progress.value = 'Reading trip file…';
  nameTouched = false;
  name.value = uniqueTripName(
    names.value,
    file.name
      .replace(/\.(ebirdtrip|gz|json)$/gi, '')
      .replace(/^ebird-trip-/i, '')
      .replace(/[-_]+/g, ' ')
      .trim() || 'Imported trip',
  );
  try {
    const payload = await decodeTripArchive(file, (fraction, stage) => {
      if (token !== loadToken) return;
      progress.value =
        stage === 'parsing'
          ? 'Preparing trip…'
          : `Reading trip file · ${Math.round(fraction * 100)}%`;
    });
    if (token !== loadToken) return;
    pendingImport.value = payload;
    if (!nameTouched) name.value = uniqueTripName(names.value, payload.trip.name);
    progress.value = '';
  } catch (failure) {
    if (token === loadToken) error.value = failure.message;
  } finally {
    if (token === loadToken) importing.value = false;
  }
};
const openImport = (file) => {
  start('import');
  loadTripFile(file);
  nextTick(() => document.getElementById('new-trip-name')?.select());
};
const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
const importStats = computed(() => {
  const payload = pendingImport.value;
  if (!payload) return [];
  const dates = tripDates(payload.visits, payload.trip.timeZone);
  const locations = payload.ebd?.locations?.length || 0;
  return [
    { icon: 'geo-alt', text: plural(payload.visits.length, 'stop') },
    dates.group !== 'undated' && { icon: 'calendar3', text: dates.label },
    locations && { icon: 'binoculars', text: plural(locations, 'eBird location') },
    payload.trip.tripReportId && { icon: 'link-45deg', text: 'eBird trip report linked' },
  ].filter(Boolean);
});
const closeImport = () => {
  loadToken += 1;
  pendingImport.value = null;
  importing.value = false;
};
const importFile = async (event) => {
  await loadTripFile(event.target.files[0]);
  event.target.value = '';
};
// The Import trip button goes straight to the file picker; the dialog opens once a file is chosen.
const pickTripFile = (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  openImport(file);
};
// Dropping an .ebirdtrip file on the trips area imports it.
const dragging = ref(false);
let dragDepth = 0;
const canDrop = (event) =>
  event.dataTransfer?.types.includes('Files') &&
  !busy.value &&
  !importing.value &&
  !createDialog.value?.open &&
  !removeDialog.value?.open;
const dragEnter = (event) => {
  if (!canDrop(event)) return;
  event.preventDefault();
  dragDepth += 1;
  dragging.value = true;
};
const dragOver = (event) => {
  if (!canDrop(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
};
const dragLeave = () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dragging.value = false;
};
const dropFile = (event) => {
  dragDepth = 0;
  dragging.value = false;
  if (!canDrop(event)) return;
  event.preventDefault();
  const file = event.dataTransfer.files[0];
  if (!file) return;
  openImport(file);
};
const importTrip = () =>
  run(async () => {
    const id = await restoreTripArchive(
      {
        ...pendingImport.value,
        trip: {
          ...pendingImport.value.trip,
          name: name.value.trim(),
          timeZone: pendingImport.value.trip.timeZone || '',
          updatedAt: Date.now(),
        },
      },
      { asCopy: true },
    );
    await finishNew(id);
  });
const exportTrip = async (item) => {
  const payload = item.localId
    ? await readTripArchive(item.localId)
    : await decodeTripArchive(await downloadCloudTrip(await getCloudTrip(item.cloudId)));
  if (!item.localId) {
    const cloud = await getWorkspaceCloud(item.cloudId, { legacy: true });
    if (cloud) {
      payload.trip = {
        ...payload.trip,
        name: cloud.plan.name,
        timeZone: cloud.plan.timeZone,
        tripReportId: cloud.plan.reportId,
      };
      payload.visits = workspaceVisits(cloud.plan, payload.trip.id);
    }
  }
  const blob = await encodeTripArchive(payload),
    url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = tripArchiveName(payload.trip.name);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const enable = (item) =>
  run(async () => {
    await enableTripCloud(item.localId);
    status.value = 'Cloud autosave enabled. Open the trip to share it.';
  });
const askRemove = (item, cloud = false) => {
  removal.value = { item, cloud };
  removeDialog.value.showModal();
};
const remove = () =>
  run(async () => {
    const { item, cloud } = removal.value;
    if (cloud) {
      const source = await getCloudTrip(item.cloudId);
      await deleteCloudTrip({ id: source.id, revision: source.revision });
      await db.workspaceSync
        .where('cloudId')
        .equals(item.cloudId)
        .modify({ cloudId: '', accountId: '', revision: '', basePlan: null, pending: null });
      cloudBindings.value = Object.fromEntries(
        Object.entries(cloudBindings.value).filter(([, binding]) => binding.id !== item.cloudId),
      );
      status.value = 'Cloud trip deleted. Device copies are kept.';
    } else {
      if (await db.workspaceRecovery.where('tripId').equals(item.localId).count())
        throw new Error('Review recovery copies inside the trip before removing this device copy.');
      await exportTrip(item);
      await db.transaction(
        'rw',
        db.trips,
        db.ebd,
        db.visits,
        db.lists,
        db.checklists,
        db.comments,
        db.workspaceSync,
        async () => {
          await db.workspaceSync.delete(item.localId);
          await db.trips.delete(item.localId);
          await db.ebd.delete(item.localId);
          for (const table of [db.visits, db.lists, db.checklists])
            await table.where('tripId').equals(item.localId).delete();
          await db.comments.delete(item.localId);
        },
      );
      cloudBindings.value = Object.fromEntries(
        Object.entries(cloudBindings.value).filter(([id]) => id !== item.localId),
      );
      await refreshTrips();
      status.value = 'Trip exported and device copy removed. Any cloud trip is kept.';
    }
    localStorage.setItem('firebaseCloudTrips', JSON.stringify(cloudBindings.value));
    removeDialog.value.close();
  });
const network = () => {
  online.value = navigator.onLine;
};
onMounted(async () => {
  window.addEventListener('online', network);
  window.addEventListener('offline', network);
  if (cloudConfigured)
    await initCloud().catch((failure) => {
      error.value = failure.message;
    });
  await refreshTrips();
  if (route.query.cloud) await router.replace({ path: '/workspace', query: route.query });
});
onBeforeUnmount(() => {
  window.removeEventListener('online', network);
  window.removeEventListener('offline', network);
});
</script>

<template>
  <div class="trip-library-page">
    <WorkspaceLoading v-if="opening" :message="opening" />
    <header class="library-header">
      <router-link to="/trips" class="library-brand"
        ><i aria-hidden="true" class="bi bi-feather"></i> eBird Trip Planner</router-link
      >
      <div class="account-actions">
        <span v-if="!online" class="library-muted">Offline</span
        ><span v-if="cloudUser" class="account-email">{{ cloudUser.email }}</span
        ><button
          v-if="cloudConfigured && !cloudUser"
          :disabled="busy || !cloudReady || !online"
          @click="run(signInCloud)"
        >
          Sign in with Google</button
        ><button v-if="cloudUser" :disabled="busy" @click="run(signOutCloud)">Sign out</button>
      </div>
    </header>
    <main class="library-content">
      <div class="library-heading">
        <div>
          <h1>My trips</h1>
        </div>
        <div class="library-actions">
          <input
            id="trip-file-picker"
            ref="tripFilePicker"
            type="file"
            hidden
            accept=".ebirdtrip,.gz,.json,application/gzip,application/json"
            @change="pickTripFile"
          /><button :disabled="busy" @click="tripFilePicker.click()">
            <i aria-hidden="true" class="bi bi-upload"></i> Import trip</button
          ><button class="primary" :disabled="busy" @click="start('new')">
            <i aria-hidden="true" class="bi bi-plus-lg"></i> New trip
          </button>
        </div>
      </div>
      <AppAlert
        v-if="error && !createDialog?.open && !removeDialog?.open"
        tone="danger"
        class="library-alert"
        @close="error = ''"
        >{{ error }}</AppAlert
      >
      <AppAlert v-if="status" tone="success" class="library-alert" @close="status = ''">{{
        status
      }}</AppAlert>
      <AppAlert v-if="cloudError" tone="danger" class="library-alert" @close="cloudError = ''">{{
        cloudError
      }}</AppAlert>
      <div
        class="library-drop-zone"
        :class="{ dragging }"
        @dragenter="dragEnter"
        @dragover="dragOver"
        @dragleave="dragLeave"
        @drop="dropFile"
      >
        <div v-if="dragging" class="library-drop-overlay" aria-hidden="true">
          <div><i class="bi bi-upload"></i> Drop an .ebirdtrip file to import it</div>
        </div>
        <template v-if="library.length">
          <section
            v-for="group in groups.filter((group) => group.trips.length)"
            :key="group.id"
            class="trip-group"
          >
            <h2>{{ group.title }}</h2>
            <div class="trip-cards">
              <article
                v-for="item in group.trips"
                :key="item.localId || item.cloudId"
                class="trip-card"
              >
                <div class="trip-card-top">
                  <span class="trip-storage"
                    ><i
                      aria-hidden="true"
                      :class="'bi bi-' + (item.cloudId ? 'cloud-check' : 'device-ssd')"
                    ></i>
                    {{ connection(item) }}</span
                  >
                  <details class="trip-card-menu">
                    <summary :aria-label="'Options for ' + item.name">
                      <i aria-hidden="true" class="bi bi-three-dots"></i>
                    </summary>
                    <div>
                      <button
                        :disabled="busy || (!item.localId && !online)"
                        @click="run(() => exportTrip(item))"
                      >
                        Export trip (.ebirdtrip)</button
                      ><button
                        v-if="item.localId && !item.sync?.cloudId && cloudUser"
                        :disabled="busy || !online"
                        @click="enable(item)"
                      >
                        Enable cloud autosave</button
                      ><button v-if="item.localId" :disabled="busy" @click="askRemove(item)">
                        Remove device copy…</button
                      ><button
                        v-if="item.cloud?.owned"
                        :disabled="busy || !online"
                        @click="askRemove(item, true)"
                      >
                        Delete cloud trip…
                      </button>
                    </div>
                  </details>
                </div>
                <h3>{{ item.name }}</h3>
                <p class="trip-dates">
                  <i class="bi bi-calendar3" aria-hidden="true"></i> {{ item.dates.label }}
                </p>
                <p class="trip-dates">
                  <i
                    aria-hidden="true"
                    :class="
                      'bi bi-' + (item.stopCount !== undefined ? 'geo-alt' : 'cloud-arrow-down')
                    "
                  ></i>
                  {{
                    item.stopCount !== undefined
                      ? item.stopCount + (item.stopCount === 1 ? ' stop' : ' stops')
                      : 'Open to download for offline use'
                  }}<span v-if="item.timeZone"> · {{ item.timeZone.replaceAll('_', ' ') }}</span>
                </p>
                <div class="trip-card-footer">
                  <button
                    class="primary"
                    :disabled="busy || (!item.localId && (!online || !cloudReady))"
                    @click="open(item)"
                  >
                    Open trip <i aria-hidden="true" class="bi bi-arrow-right"></i>
                  </button>
                </div>
              </article>
            </div>
          </section>
        </template>
        <div v-else class="library-empty">
          <button class="primary library-first-trip" @click="start('new')">
            <i aria-hidden="true" class="bi bi-plus-lg"></i> Create your first trip
          </button>
          <p>or drop an .ebirdtrip file here</p>
        </div>
      </div>
      <footer class="library-footer">
        <div class="library-footer-links">
          <span>v{{ version }}</span
          ><span class="dot" aria-hidden="true">·</span
          ><a href="https://github.com/Zoziologie/ebird-trip-planner" target="_blank" rel="noopener"
            ><i aria-hidden="true" class="bi bi-github"></i> GitHub</a
          ><span class="dot" aria-hidden="true">·</span
          ><a
            class="library-sponsor"
            href="https://github.com/sponsors/Zoziologie"
            target="_blank"
            rel="noopener"
            ><i aria-hidden="true" class="bi bi-heart-fill"></i> Support</a
          ><span class="dot" aria-hidden="true">·</span><span>Powered by</span
          ><a
            class="library-zoziologie"
            href="https://zoziologie.raphaelnussbaumer.com/"
            target="_blank"
            rel="noopener"
            ><img :src="zoziologieLogo" alt="" /> Zoziologie</a
          >
        </div>
        <details v-if="cloudUser">
          <summary>Cloud storage & account</summary>
          <p>
            {{ cloudAllowance }} cloud {{ cloudAllowance === 1 ? 'trip' : 'trips' }} · 50 MB per
            source dataset. Offline changes sync when connected.
          </p>
          <p>
            Trips inactive for more than six months may be removed. Export an .ebirdtrip file to
            keep a copy.
          </p>
        </details>
      </footer>
    </main>
    <dialog
      ref="createDialog"
      class="library-dialog"
      @close="closeImport"
      @cancel="busy ? $event.preventDefault() : null"
    >
      <div class="library-dialog-heading">
        <h2>{{ mode === 'import' ? 'Import an eBird trip' : 'New trip' }}</h2>
        <button
          aria-label="Close new trip"
          :disabled="busy || (importing && mode !== 'import')"
          @click="createDialog.close()"
        >
          <i aria-hidden="true" class="bi bi-x-lg"></i>
        </button>
      </div>
      <AppAlert v-if="error" tone="danger" class="library-alert" @close="error = ''">{{
        error
      }}</AppAlert>
      <template v-if="mode === 'import' && (importing || pendingImport)"
        ><label for="new-trip-name" class="visually-hidden">Trip name</label
        ><input
          id="new-trip-name"
          v-model="name"
          class="library-import-name"
          :disabled="busy"
          placeholder="Trip name"
          @input="nameTouched = true"
        />
        <p v-if="duplicate" class="library-error">
          Choose a different name; this name is already used.
        </p>
        <ul v-if="pendingImport" class="library-import-stats">
          <li v-for="stat in importStats" :key="stat.icon">
            <i aria-hidden="true" :class="'bi bi-' + stat.icon"></i> {{ stat.text }}
          </li>
        </ul>
        <p v-else role="status" class="library-muted">{{ progress }}</p>
        <label v-if="cloudUser && online" class="library-check"
          ><input v-model="saveOnline" type="checkbox" /> Enable cloud autosave</label
        ></template
      >
      <template v-if="mode === 'import' && error && !importing"
        ><label for="trip-archive-input">Choose another file</label
        ><input
          id="trip-archive-input"
          type="file"
          accept=".ebirdtrip,.gz,.json,application/gzip,application/json"
          :disabled="busy"
          @change="importFile"
      /></template>
      <div v-if="mode !== 'import'" class="library-create-actions">
        <Initiate
          :disabled="busy"
          :can-create="Boolean(name.trim() && !duplicate)"
          :create-trip="create"
          @busy="importing = $event"
        >
          <template #trip-details>
            <label for="new-trip-name">Trip name</label>
            <input
              id="new-trip-name"
              v-model="name"
              :disabled="busy || importing"
              placeholder="e.g. Oman, February"
            />
            <p v-if="duplicate" class="library-error">
              Choose a different name; this name is already used.
            </p>
            <label v-if="cloudUser && online" class="library-check"
              ><input v-model="saveOnline" type="checkbox" /> Enable cloud autosave</label
            >
          </template>
        </Initiate>
      </div>
      <button
        v-else-if="importing || pendingImport"
        class="primary"
        :disabled="busy || !pendingImport || !name.trim() || duplicate"
        @click="importTrip"
      >
        {{ pendingImport ? 'Import trip' : 'Reading trip file…' }}
      </button>
    </dialog>
    <dialog ref="removeDialog" class="library-dialog">
      <template v-if="removal"
        ><h2>{{ removal.cloud ? 'Delete cloud trip?' : 'Remove device copy?' }}</h2>
        <p>
          <strong>{{ removal.item.name }}</strong>
        </p>
        <p>
          {{
            removal.cloud
              ? 'Shared links will stop working. Copies already on this device are kept.'
              : 'The trip is exported as an .ebirdtrip file before removal. Any cloud version stays available. Keep that file to restore device-only edits.'
          }}
        </p>
        <AppAlert v-if="error" tone="danger" class="library-alert" @close="error = ''">{{
          error
        }}</AppAlert>
        <div class="library-actions">
          <button :disabled="busy" @click="removeDialog.close()">Cancel</button
          ><button :disabled="busy" @click="remove">
            {{ removal.cloud ? 'Delete cloud trip' : 'Export & remove device copy' }}
          </button>
        </div></template
      >
    </dialog>
  </div>
</template>

<style src="../components/workspace/library.css"></style>
