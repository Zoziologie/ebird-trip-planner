<script setup>
import { ref, shallowRef, onMounted, onBeforeUnmount, watch, computed } from "vue";
import { liveQuery } from "dexie";
import {
  db,
  deleteTripChecklists,
  deleteTripComments,
  storeTripChecklists,
  storeTripComments,
} from "../data/db";
import Initiate from "../components/Initiate.vue";
import LifeList from "../components/LifeList.vue";
import { useTripBundleLoader } from "../composables/useTripBundleLoader";
import { trips, selectedTripId, refreshTrips } from "../state/tripSelection";
import { bumpEbdUpdatedAt } from "../state/ebdUpdates";
import { resolveRecordConflict, withUpdatedAt } from "../utils/recordConflicts";
import { resolveSpeciesTaxon, extractTaxonFields } from "../utils/taxonomy";
import { EMPTY_REGION, readTripArchive, restoreTripArchive } from "../utils/tripData";
import { encodeTripArchive, decodeTripArchive, tripArchiveName } from "../utils/tripArchive";
import CloudTrips from "../components/CloudTrips.vue";
import { cloudBindings, cloudLibrary } from "../state/cloudTrips";
import { findTripByName, uniqueTripName } from "../utils/tripNames";
import zoziologieLogoUrl from "../assets/zoziologie-logo.svg";

const tripForm = ref({
  name: "",
  tripReportId: "",
});

const processedData = shallowRef(null);
const tripEditTimes = ref({});
const tripVisitCounts = ref({});
const addTripMode = ref("");
const isCreating = ref(false);
const newTripName = ref("");
const libraryNames = computed(() => [...trips.value, ...cloudLibrary.value.filter(trip => trip.revision)]);
const hasNewTripName = computed(() => Boolean(newTripName.value.trim()));
const duplicateNewTripName = computed(() => findTripByName(libraryNames.value, newTripName.value));
const pendingImport = shallowRef(null);
const importName = ref("");
const importCollision = computed(() => pendingImport.value && findTripByName(libraryNames.value, pendingImport.value.trip.name));
const localImportCollision = computed(() => pendingImport.value && findTripByName(trips.value, pendingImport.value.trip.name));
const duplicateImportName = computed(() => findTripByName(libraryNames.value, importName.value));
const importProgress = ref(null);
const importStage = ref("");
const transferFailed = ref(false);
const welcome = computed(() => !trips.value.length && !cloudLibrary.value.some(trip => trip.revision));
watch(addTripMode, mode => {
  if (mode) transferStatus.value = "";
  if (mode !== "import") pendingImport.value = null;
});
const editTimesSubscription = liveQuery(() => db.transaction("r", db.trips, db.ebd, db.visits, async () => {
  // Read only the EBD timestamp index, rather than loading the large bird datasets.
  const [allTrips, ebdIds, ebdTimes, visits] = await Promise.all([
    db.trips.toArray(), db.ebd.orderBy("updatedAt").primaryKeys(),
    db.ebd.orderBy("updatedAt").keys(), db.visits.toArray(),
  ]);
  const times = Object.fromEntries(allTrips.map(trip => [trip.id, Number(trip.updatedAt || 0)]));
  ebdIds.forEach((id, index) => { times[id] = Math.max(times[id] || 0, Number(ebdTimes[index])); });
  visits.forEach(visit => { times[visit.tripId] = Math.max(times[visit.tripId] || 0, Number(visit.updatedAt || 0)); });
  return { times, counts: visits.reduce((counts, visit) => { counts[visit.tripId] = (counts[visit.tripId] || 0) + 1; return counts; }, {}) };
})).subscribe(({ times, counts }) => { tripEditTimes.value = times; tripVisitCounts.value = counts; });
onBeforeUnmount(() => editTimesSubscription.unsubscribe());
const saveStatus = ref("");
const loadedTrip = ref(null);
const isExporting = ref(false);
const isImporting = ref(false);
const transferStatus = ref("");
const isSyncingTripReport = ref(false);
const isClearingTripReport = ref(false);
const tripReportStatus = ref("");
const tripReportAlertMessage = computed(() => {
  if (tripReportStatus.value) return tripReportStatus.value;
  if (lastTripReportSyncTime.value) return "Trip report species synced.";
  return "";
});
const tripReportAlertVariant = computed(() => {
  const text = (tripReportStatus.value || "").toLowerCase();
  if (text.includes("failed") || text.includes("error")) return "danger";
  if (text.includes("warning")) return "warning";
  if (text.includes("canceled")) return "warning";
  if (text.includes("load")) return "warning";
  if (tripReportStatus.value) return "info";
  if (lastTripReportSyncTime.value) return "success";
  return "info";
});
const tripReportAlertIcon = computed(() => {
  const variant = tripReportAlertVariant.value;
  if (variant === "success") return "bi-check-circle-fill";
  if (variant === "danger") return "bi-exclamation-triangle-fill";
  if (variant === "warning") return "bi-exclamation-triangle-fill";
  return "bi-info-circle-fill";
});
const showLastSyncLabel = computed(
  () => tripReportAlertVariant.value === "success" && lastTripReportSyncTime.value,
);
const lastTripReportSyncTime = ref(null);
const installPromptEvent = ref(null);
const isPwaInstalled = ref(false);
const canInstallPwa = computed(() => Boolean(installPromptEvent.value) && !isPwaInstalled.value);
const { loadTripBundle, resetTripBundleLoader } = useTripBundleLoader({
  includeTrip: true,
  includeEbd: true,
});
const appVersion = __APP_VERSION__;
const repoUrl = "https://github.com/Zoziologie/ebird-trip-planner";
const sponsorUrl = "https://github.com/sponsors/Zoziologie";
const zoziologieUrl = "https://zoziologie.raphaelnussbaumer.com/";

const formatSyncTimestamp = (value) => {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "";
  }
};

const handleBeforeInstallPrompt = (event) => {
  event.preventDefault();
  installPromptEvent.value = event;
};

const handleAppInstalled = () => {
  isPwaInstalled.value = true;
  installPromptEvent.value = null;
};

const triggerPwaInstall = async () => {
  const prompt = installPromptEvent.value;
  if (!prompt) return;
  prompt.prompt();
  try {
    const { outcome } = await prompt.userChoice;
    if (outcome === "accepted") {
      installPromptEvent.value = null;
    }
  } catch (error) {
    console.warn("Install prompt failed", error);
  }
};

const loadTrips = async () => {
  await refreshTrips();
};

const resetLocalState = () => {
  loadedTrip.value = null;
  processedData.value = null;
  saveStatus.value = "";
  tripForm.value = { name: "", tripReportId: "" };
  lastTripReportSyncTime.value = null;
};

const cloneTripFilters = (filters) => ({
  minYear: filters?.minYear ?? null,
  maxYear: filters?.maxYear ?? null,
  minMonth: filters?.minMonth ?? null,
  maxMonth: filters?.maxMonth ?? null,
  state: Array.isArray(filters?.state) ? [...filters.state] : [],
  county: Array.isArray(filters?.county) ? [...filters.county] : [],
});

const createTripFromProcessed = async (payload, onProgress) => {
  const now = Date.now();
  const id = crypto.randomUUID();
  const tripName = newTripName.value.trim();
  await db.trips.put({
    id,
    name: tripName,
    tripReportId: "",
    createdAt: now,
    updatedAt: now,
  });
  onProgress(1, 5, "save steps");
  await db.ebd.put({
    tripId: id,
    speciesList: payload?.speciesList || [],
    locations: payload?.locations || [],
    region: payload?.region || { code: "", name: "" },
    filters: cloneTripFilters(payload?.filters),
    updatedAt: now,
  });
  onProgress(2, 5, "save steps");
  await storeTripChecklists(id, payload?.checklists);
  onProgress(3, 5, "save steps");
  await storeTripComments(id, payload?.comments);
  onProgress(4, 5, "save steps");
  bumpEbdUpdatedAt();
  await loadTrips();
  selectedTripId.value = id;
  await loadTripData(id);
  onProgress(5, 5, "save steps");
  newTripName.value = "";
  addTripMode.value = "";
  setSaveStatus("Trip created in this browser. Save to cloud when ready.");
};

const handleProcessed = async (payload, onProgress) => {
  saveStatus.value = "";
  await createTripFromProcessed(payload, onProgress);
};

const isRenameModalOpen = ref(false);
const renameTripName = ref("");
const normalizedRenameTripName = computed(() => renameTripName.value.trim().toLowerCase());
const hasDuplicateRename = computed(() => {
  if (!normalizedRenameTripName.value) return false;
  return trips.value.some(
    (trip) =>
      trip.name?.trim().toLowerCase() === normalizedRenameTripName.value &&
      trip.id !== selectedTripId.value,
  );
});

const speciesList = computed(() => processedData.value?.speciesList || []);
const region = computed(() => processedData.value?.region || EMPTY_REGION);
const totalSpeciesCount = computed(() => speciesList.value.length);
const hasLifeList = computed(() =>
  speciesList.value.some((species) => species.liferWorld === true || species.liferWorld === false),
);
const hasRegionList = computed(() =>
  speciesList.value.some((species) => species.liferRegion === true || species.liferRegion === false),
);
const isTripConfirmedSpecies = (species) => species?.tripReportSeen === true;
const isWorldTargetSpecies = (species) =>
  species?.liferWorld === true && !isTripConfirmedSpecies(species);
const isRegionTargetSpecies = (species) =>
  species?.liferRegion === true && !isTripConfirmedSpecies(species);
const newWorldCount = computed(
  () => speciesList.value.filter((species) => isWorldTargetSpecies(species)).length,
);
const newRegionCount = computed(
  () => speciesList.value.filter((species) => isRegionTargetSpecies(species)).length,
);
const newTripCount = computed(
  () => speciesList.value.filter((species) => species.tripReportSeen === false).length,
);
const hasTripReportState = computed(() => {
  if (tripForm.value.tripReportId) return true;
  if (lastTripReportSyncTime.value) return true;
  return speciesList.value.some(
    (species) => species.tripReportSeen === true || species.tripReportSeen === false,
  );
});
const worldTargetsLink = Object.freeze({
  path: "/speciesList",
  query: { filter: "life" },
});
const regionTargetsLink = Object.freeze({
  path: "/speciesList",
  query: { filter: "region" },
});

const openRenameModal = () => {
  if (!selectedTripId.value) return;
  renameTripName.value = tripForm.value.name || loadedTrip.value?.name || "";
  isRenameModalOpen.value = true;
};

const closeRenameModal = () => {
  isRenameModalOpen.value = false;
};

const saveRenameTrip = async () => {
  if (!selectedTripId.value) return;
  const nextName = renameTripName.value.trim();
  if (!nextName || hasDuplicateRename.value) return;
  const updated = await updateCurrentTrip({ name: nextName });
  if (!updated) return;
  closeRenameModal();
};

const persistTripReportId = async () => {
  if (!selectedTripId.value) return;
  await updateCurrentTrip({
    tripReportId: tripForm.value.tripReportId,
  });
};

let statusTimer = null;
const setSaveStatus = (message) => {
  saveStatus.value = message;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    saveStatus.value = "";
  }, 2000);
};

const reloadCurrentTripState = async (message) => {
  await loadTrips();
  if (selectedTripId.value) {
    await loadTripData(selectedTripId.value);
  } else {
    resetLocalState();
  }
  if (message) setSaveStatus(message);
};

const updateCurrentTrip = async (updates, successMessage = "Trip details updated.") => {
  if (!selectedTripId.value) return false;
  const currentTrip = await db.trips.get(selectedTripId.value);
  if (!currentTrip) {
    await reloadCurrentTripState("Trip no longer exists.");
    return false;
  }

  const localUpdatedAt = Number(loadedTrip.value?.updatedAt ?? 0);
  const dbUpdatedAt = Number(currentTrip.updatedAt ?? 0);
  if (loadedTrip.value) {
    const shouldOverwrite = await resolveRecordConflict({
      label: "This trip",
      localUpdatedAt,
      currentUpdatedAt: dbUpdatedAt,
      reload: async () => {
        await reloadCurrentTripState("Latest trip data reloaded.");
      },
    });
    if (!shouldOverwrite) return false;
  }

  const nextUpdates = withUpdatedAt(updates);
  await db.trips.update(selectedTripId.value, nextUpdates);
  await loadTrips();
  loadedTrip.value = await db.trips.get(selectedTripId.value);
  if (loadedTrip.value) {
    tripForm.value = {
      name: loadedTrip.value.name || "",
      tripReportId: loadedTrip.value.tripReportId || "",
    };
  }
  if (successMessage) setSaveStatus(successMessage);
  return true;
};

const updateCurrentEbd = async (updates, successMessage = "Trip details updated.") => {
  if (!selectedTripId.value) return false;
  const currentEbd = await db.ebd.get(selectedTripId.value);
  if (!currentEbd) {
    await reloadCurrentTripState("Trip data no longer exists.");
    return false;
  }

  const localUpdatedAt = Number(processedData.value?.updatedAt ?? 0);
  const dbUpdatedAt = Number(currentEbd.updatedAt ?? 0);
  if (processedData.value) {
    const shouldOverwrite = await resolveRecordConflict({
      label: "This trip data",
      localUpdatedAt,
      currentUpdatedAt: dbUpdatedAt,
      reload: async () => {
        await reloadCurrentTripState("Latest trip data reloaded.");
      },
    });
    if (!shouldOverwrite) return false;
  }

  const nextEntry = {
    ...currentEbd,
    ...withUpdatedAt(updates),
    tripId: selectedTripId.value,
  };
  await db.ebd.put(nextEntry);
  processedData.value = nextEntry;
  bumpEbdUpdatedAt();
  if (successMessage) setSaveStatus(successMessage);
  return true;
};

const handleSpeciesListUpdate = async (updatedList) => {
  if (!selectedTripId.value || !processedData.value) return;
  await updateCurrentEbd({
    speciesList: updatedList,
  });
};

const loadTripData = async (tripId) => {
  if (!tripId) {
    resetTripBundleLoader();
    resetLocalState();
    return;
  }

  const { bundle, isCurrent } = await loadTripBundle(tripId);
  if (!isCurrent) return;

  loadedTrip.value = bundle.trip;
  if (loadedTrip.value) {
    tripForm.value = {
      name: loadedTrip.value.name || "",
      tripReportId: loadedTrip.value.tripReportId || "",
    };
  } else {
    tripForm.value = { name: "", tripReportId: "" };
  }
  lastTripReportSyncTime.value = loadedTrip.value?.tripReportSyncedAt || null;
  processedData.value = bundle.ebd || null;
  saveStatus.value = "";
};

watch(selectedTripId, loadTripData, { immediate: true });
watch(selectedTripId, () => { transferStatus.value = ""; });

onMounted(async () => {
  await loadTrips();
  await loadTripData(selectedTripId.value);
  window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  window.addEventListener("appinstalled", handleAppInstalled);
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  window.removeEventListener("appinstalled", handleAppInstalled);
});

const deleteTrip = async () => {
  if (!selectedTripId.value) return;
  const tripName = loadedTrip.value?.name || "this trip";
  const confirmed = window.confirm(`Remove "${tripName}" from this browser? Browser-only edits will be lost. Its cloud trip, if any, will stay available. Download a backup first if needed.`);
  if (!confirmed) return;
  const currentTrip = await db.trips.get(selectedTripId.value);
  if (!currentTrip) {
    await reloadCurrentTripState("Trip no longer exists.");
    return;
  }
  const localUpdatedAt = Number(loadedTrip.value?.updatedAt ?? 0);
  const dbUpdatedAt = Number(currentTrip.updatedAt ?? 0);
  if (loadedTrip.value) {
    const shouldDelete = await resolveRecordConflict({
      label: "This trip",
      localUpdatedAt,
      currentUpdatedAt: dbUpdatedAt,
      reload: async () => {
        await reloadCurrentTripState("Latest trip data reloaded.");
      },
    });
    if (!shouldDelete) return;
  }
  const tripId = selectedTripId.value;
  await db.trips.delete(tripId);
  if (cloudBindings.value[tripId]) {
    cloudBindings.value = Object.fromEntries(Object.entries(cloudBindings.value).filter(([id]) => id !== tripId));
    localStorage.setItem("firebaseCloudTrips", JSON.stringify(cloudBindings.value));
  }
  await db.ebd.where("tripId").equals(tripId).delete();
  await db.visits.where("tripId").equals(tripId).delete();
  await db.lists.where("tripId").equals(tripId).delete();
  await deleteTripChecklists(tripId);
  await deleteTripComments(tripId);
  bumpEbdUpdatedAt();
  resetLocalState();
  await loadTrips();
  setSaveStatus("Trip removed from this browser.");
};

const normalizeTripReportId = (value) => (value || "").trim();

const extractTripReportSpecies = (payload) => {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return payload.species || payload.taxa || payload.taxons || payload.data || payload.list || [];
};

const normalizeTripReportEntry = (entry) => {
  if (typeof entry === "string") {
    const value = entry.trim();
    if (!value) return null;
    const looksLikeScientificName = value.includes(" ");
    const resolvedTaxon = resolveSpeciesTaxon({
      speciesCode: looksLikeScientificName ? "" : value,
      scientificName: looksLikeScientificName ? value : "",
    });
    if (!resolvedTaxon) return null;
    return {
      code: resolvedTaxon.speciesCode || (looksLikeScientificName ? "" : value),
      scientificName: resolvedTaxon.sciName || (looksLikeScientificName ? value : ""),
      commonName: resolvedTaxon.comName || "",
      taxonOrder: resolvedTaxon.taxonOrder ?? Infinity,
    };
  }

  if (!entry || typeof entry !== "object") return null;
  const { speciesCode, scientificName, commonName, category, reportAs } = extractTaxonFields(entry);

  const resolvedTaxon = resolveSpeciesTaxon({
    speciesCode,
    scientificName,
    category,
    reportAs,
  });
  if (!resolvedTaxon) return null;

  const rawTaxonOrder = Number(entry.taxonOrder ?? entry.taxon_order);
  return {
    code: resolvedTaxon.speciesCode || speciesCode || scientificName,
    scientificName: resolvedTaxon.sciName || scientificName,
    commonName: resolvedTaxon.comName || commonName,
    taxonOrder: Number.isFinite(rawTaxonOrder)
      ? rawTaxonOrder
      : (resolvedTaxon.taxonOrder ?? Infinity),
  };
};

const getCanonicalSpeciesCode = (species) => {
  const resolvedTaxon = resolveSpeciesTaxon({
    speciesCode: species?.code,
    scientificName: species?.scientificName,
  });
  return resolvedTaxon?.speciesCode || species?.code || "";
};

const collectEbdSpeciesCodes = (locations) => {
  const codes = new Set();
  if (!Array.isArray(locations)) return codes;

  const rawCodes = new Set();
  locations.forEach((location) => {
    const entries = Array.isArray(location?.species_checklist_counts)
      ? location.species_checklist_counts
      : [];
    entries.forEach(([code]) => {
      if (code) rawCodes.add(code);
    });
  });

  rawCodes.forEach((code) => {
    const resolvedTaxon = resolveSpeciesTaxon({ speciesCode: code });
    const normalizedCode = resolvedTaxon?.speciesCode || code;
    if (normalizedCode) codes.add(normalizedCode);
  });

  return codes;
};

const clearTripReportSpeciesState = (list, locations) => {
  const ebdCodeSet = collectEbdSpeciesCodes(locations);
  const baselineSpecies = (Array.isArray(list) ? list : []).filter((species) => {
    if (ebdCodeSet.size === 0) return true;
    const canonicalCode = getCanonicalSpeciesCode(species);
    return canonicalCode && ebdCodeSet.has(canonicalCode);
  });

  return baselineSpecies.map((species) => {
    const { tripReportSeen, ...rest } = species;
    return rest;
  });
};

const formatSpeciesLabel = (species) => {
  const common = (species?.commonName || "").trim();
  const scientific = (species?.scientificName || "").trim();
  const code = (species?.code || "").trim();
  const base =
    common && scientific ? `${common} (${scientific})` : common || scientific || "Unknown species";
  return code ? `${base} [${code}]` : base;
};

const syncTripReportSpecies = async () => {
  const tripReportId = normalizeTripReportId(tripForm.value.tripReportId);
  if (!selectedTripId.value || !tripReportId) return;
  if (!processedData.value) {
    tripReportStatus.value = "Load a trip species list before syncing.";
    return;
  }
  isSyncingTripReport.value = true;
  tripReportStatus.value = "";
  try {
    tripReportStatus.value = "Downloading trip report species…";
    const response = await fetch(
      "https://tripreport.raphaelnussbaumer.com/tripreport-internal/v1/taxon-list/" + tripReportId,
    );
    if (!response.ok) throw new Error(`Trip report request failed: ${response.status}`);
    const payload = await response.json();
    tripReportStatus.value = "Matching trip report species…";
    const entries = extractTripReportSpecies(payload);
    const prepared = entries.map((entry) => normalizeTripReportEntry(entry)).filter(Boolean);
    const codeSet = new Set(prepared.map((item) => item.code).filter(Boolean));
    const sciSet = new Set(prepared.map((item) => item.scientificName).filter(Boolean));
    const ebdCodeSet = collectEbdSpeciesCodes(processedData.value?.locations || []);
    const outsideEbdSpecies = prepared.filter((species) => {
      if (ebdCodeSet.size === 0) return false;
      return species.code && !ebdCodeSet.has(species.code);
    });
    if (outsideEbdSpecies.length > 0) {
      const uniqueOutside = Array.from(
        new Map(
          outsideEbdSpecies.map((species) => [species.code || species.scientificName, species]),
        ).values(),
      );
      const speciesListText = uniqueOutside
        .map((species, index) => `${index + 1}. ${formatSpeciesLabel(species)}`)
        .join("\n");
      const confirmed = window.confirm(
        [
          "This trip report includes species not found in the original EBD species list:",
          "",
          speciesListText,
          "",
          "Press OK to continue and add them.",
          "Press Cancel to abort this trip report sync.",
        ].join("\n"),
      );
      if (!confirmed) {
        tripReportStatus.value = "Trip report sync canceled.";
        return;
      }
    }

    const existing = processedData.value?.speciesList || [];
    const baselineSpecies = existing.filter((species) => {
      if (ebdCodeSet.size === 0) return true;
      const canonicalCode = getCanonicalSpeciesCode(species);
      return canonicalCode && ebdCodeSet.has(canonicalCode);
    });
    const removedOutsideEbdCount = Math.max(existing.length - baselineSpecies.length, 0);

    const nextList = baselineSpecies.map((species) => {
      const match =
        (species.code && codeSet.has(species.code)) ||
        (species.scientificName && sciSet.has(species.scientificName));
      return {
        ...species,
        tripReportSeen: match,
      };
    });

    const existingCodes = new Set(nextList.map((item) => item.code).filter(Boolean));
    const existingSciNames = new Set(
      nextList.map((item) => item.scientificName).filter(Boolean),
    );
    prepared.forEach((species) => {
      if (!species.code && !species.scientificName) return;
      const exists =
        (species.code && existingCodes.has(species.code)) ||
        (species.scientificName && existingSciNames.has(species.scientificName));
      if (exists) return;
      const nextCode = species.code || species.scientificName || "unknown";
      existingCodes.add(nextCode);
      if (species.scientificName) existingSciNames.add(species.scientificName);
      nextList.push({
        code: nextCode,
        commonName: species.commonName || species.code || species.scientificName || "Unknown",
        scientificName: species.scientificName || "",
        taxonOrder: species.taxonOrder ?? Infinity,
        tripReportSeen: true,
      });
    });

    tripReportStatus.value = "Saving trip report species…";
    const syncTimestamp = Date.now();
    const updated = await updateCurrentEbd({
      speciesList: nextList,
      updatedAt: syncTimestamp,
    }, "");
    if (!updated) {
      tripReportStatus.value = "Trip report sync canceled. Latest trip data reloaded.";
      return;
    }
    await db.trips.update(selectedTripId.value, { tripReportSyncedAt: syncTimestamp });
    lastTripReportSyncTime.value = syncTimestamp;
    tripReportStatus.value =
      removedOutsideEbdCount > 0
        ? `Trip report species synced. ${removedOutsideEbdCount} previously added non-EBD species were removed from this trip.`
        : "Trip report species synced.";
  } catch (error) {
    tripReportStatus.value = `Trip report sync failed: ${error.message || error}`;
  } finally {
    isSyncingTripReport.value = false;
  }
};

const clearTripReportSync = async () => {
  if (!selectedTripId.value || !hasTripReportState.value) return;
  const confirmed = window.confirm(
    "Clear the trip report ID and remove all synced trip report statuses for this trip?",
  );
  if (!confirmed) return;

  isClearingTripReport.value = true;
  tripReportStatus.value = "";
  try {
    const currentTrip = await db.trips.get(selectedTripId.value);
    if (!currentTrip) {
      await reloadCurrentTripState("Trip no longer exists.");
      return;
    }

    const localTripUpdatedAt = Number(loadedTrip.value?.updatedAt ?? 0);
    const dbTripUpdatedAt = Number(currentTrip.updatedAt ?? 0);
    if (loadedTrip.value) {
      const shouldOverwriteTrip = await resolveRecordConflict({
        label: "This trip",
        localUpdatedAt: localTripUpdatedAt,
        currentUpdatedAt: dbTripUpdatedAt,
        reload: async () => {
          await reloadCurrentTripState("Latest trip data reloaded.");
        },
      });
      if (!shouldOverwriteTrip) return;
    }

    const currentEbd = await db.ebd.get(selectedTripId.value);
    if (processedData.value && currentEbd) {
      const localEbdUpdatedAt = Number(processedData.value?.updatedAt ?? 0);
      const dbEbdUpdatedAt = Number(currentEbd.updatedAt ?? 0);
      const shouldOverwriteEbd = await resolveRecordConflict({
        label: "This trip data",
        localUpdatedAt: localEbdUpdatedAt,
        currentUpdatedAt: dbEbdUpdatedAt,
        reload: async () => {
          await reloadCurrentTripState("Latest trip data reloaded.");
        },
      });
      if (!shouldOverwriteEbd) return;
    }

    const nextSpeciesList = clearTripReportSpeciesState(
      processedData.value?.speciesList || currentEbd?.speciesList || [],
      processedData.value?.locations || currentEbd?.locations || [],
    );
    const removedSpeciesCount = Math.max(
      (processedData.value?.speciesList || currentEbd?.speciesList || []).length - nextSpeciesList.length,
      0,
    );
    const tripUpdates = withUpdatedAt({
      tripReportId: "",
      tripReportSyncedAt: null,
    });
    const ebdUpdates = currentEbd
      ? {
          ...currentEbd,
          ...withUpdatedAt({ speciesList: nextSpeciesList }),
          tripId: selectedTripId.value,
        }
      : null;

    await db.transaction("rw", db.trips, db.ebd, async () => {
      await db.trips.update(selectedTripId.value, tripUpdates);
      if (ebdUpdates) {
        await db.ebd.put(ebdUpdates);
      }
    });

    await loadTrips();
    loadedTrip.value = await db.trips.get(selectedTripId.value);
    tripForm.value = {
      name: loadedTrip.value?.name || "",
      tripReportId: "",
    };
    if (ebdUpdates) {
      processedData.value = ebdUpdates;
      bumpEbdUpdatedAt();
    }
    lastTripReportSyncTime.value = null;
    tripReportStatus.value =
      removedSpeciesCount > 0
        ? `Trip report sync cleared. ${removedSpeciesCount} added non-EBD species were removed.`
        : "Trip report sync cleared.";
    setSaveStatus("Trip report sync cleared.");
  } catch (error) {
    tripReportStatus.value = `Trip report clear failed: ${error.message || error}`;
  } finally {
    isClearingTripReport.value = false;
  }
};

const exportTrip = async () => {
  if (!selectedTripId.value) return;
  isExporting.value = true;
  transferStatus.value = "Preparing backup…";
  transferFailed.value = false;
  try {
    const payload = await readTripArchive(selectedTripId.value);
    const blob = await encodeTripArchive(payload);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = tripArchiveName(payload.trip.name);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    transferStatus.value = "Backup downloaded.";
  } catch (error) {
    transferFailed.value = true;
    transferStatus.value = `Export failed: ${error.message || error}`;
  } finally {
    isExporting.value = false;
  }
};

const finishImport = async (replace = false) => {
  const payload = pendingImport.value;
  const target = replace ? findTripByName(trips.value, payload.trip.name) : null;
  isImporting.value = true;
  importStage.value = "Saving trip in this browser";
  importProgress.value = 0;
  transferStatus.value = "";
  transferFailed.value = false;
  try {
    const tripId = await restoreTripArchive({ ...payload, trip: { ...payload.trip, name: replace ? target.name : importName.value.trim(), updatedAt: Date.now() } }, {
      asCopy: true, targetTripId: target?.id || "", onProgress: value => { importProgress.value = Math.round(value * 100); },
    });
    importStage.value = "Opening trip";
    importProgress.value = null;
    bumpEbdUpdatedAt();
    await loadTrips();
    selectedTripId.value = tripId;
    await loadTripData(tripId);
    pendingImport.value = null;
    addTripMode.value = "";
    transferStatus.value = "Trip imported. Save to cloud when ready.";
  } catch (error) {
    transferFailed.value = true;
    transferStatus.value = `Import failed: ${error.message || error}`;
  } finally {
    isImporting.value = false;
  }
};

const importTrip = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  transferStatus.value = "";
  transferFailed.value = false;
  pendingImport.value = null;
  isImporting.value = true;
  importStage.value = "Reading trip file";
  importProgress.value = 0;
  try {
    pendingImport.value = await decodeTripArchive(file, (value, stage) => {
      importStage.value = stage === 'parsing' ? "Preparing trip data" : "Reading trip file";
      importProgress.value = stage === 'parsing' ? null : Math.round(value * 100);
    });
    importName.value = uniqueTripName(libraryNames.value, pendingImport.value.trip.name);
    if (!importCollision.value) await finishImport();
  } catch (error) {
    transferFailed.value = true;
    transferStatus.value = `Import failed: ${error.message || error}`;
  } finally {
    isImporting.value = false;
    event.target.value = "";
  }
};

</script>

<template>
  <div class="d-flex justify-content-between align-items-start gap-3 mb-3">
    <div>
      <h1 class="h4 mb-1">{{ welcome ? "Welcome to eBird Trip Planner" : "Your birding trips" }}</h1>
      <p class="text-muted small mb-0">{{ welcome ? "Start with eBird data or a saved trip file. Then add your targets and plan where to go." : "Choose a trip, create one from eBird data, or import a saved file." }}</p>
    </div>
    <button v-if="canInstallPwa" class="btn btn-outline-secondary btn-sm" type="button" @click="triggerPwaInstall">Install app</button>
  </div>
  <CloudTrips :local-trips="trips" :edit-times="tripEditTimes" :visit-counts="tripVisitCounts" :adding-trip="Boolean(addTripMode)" :external-busy="isImporting || isCreating"
    :last-local-edit="tripEditTimes[selectedTripId] || 0" :local-visit-count="tripVisitCounts[selectedTripId] || 0" @opened="loadTripData" @selected="addTripMode = ''; transferStatus = ''">
    <template #add-trip="{ busy }">
      <div class="border-top pt-3 mt-3">
        <h3 class="h6">Add a trip</h3>
        <div class="d-flex gap-2 flex-wrap">
          <button class="btn btn-outline-primary btn-sm" :disabled="busy || isImporting" :aria-expanded="addTripMode === 'create'" @click="addTripMode = addTripMode === 'create' ? '' : 'create'">Create from eBird data</button>
          <button class="btn btn-outline-secondary btn-sm" :disabled="busy || isImporting" :aria-expanded="addTripMode === 'import'" @click="addTripMode = addTripMode === 'import' ? '' : 'import'">Import trip file</button>
        </div>
      </div>
    </template>
    <template #new-trip="{ busy }">
      <section v-show="addTripMode" class="card mb-3" aria-label="Add a new trip">
        <div class="card-body">
          <div class="d-flex justify-content-between gap-3 align-items-start mb-2">
            <h2 class="h5 mb-0">{{ addTripMode === 'create' ? 'Create a new birding trip' : 'Import a saved trip file' }}</h2>
          </div>
          <p class="text-muted small">The trip will open in this browser. You can save it to cloud afterwards.</p>
          <div v-show="addTripMode === 'create'">
            <label for="new-trip-name" class="form-label fw-semibold">Trip name</label>
            <input id="new-trip-name" v-model="newTripName" class="form-control mb-2" placeholder="e.g. Kenya, December 2026" :disabled="isCreating" required />
            <p v-if="duplicateNewTripName" class="small text-danger">A trip with this name already exists. Choose another name.</p>
            <Initiate :disabled="busy" :can-create="hasNewTripName && !duplicateNewTripName" :create-trip="handleProcessed" @busy="isCreating = $event" />
          </div>
          <div v-if="addTripMode === 'import'">
            <label for="trip-archive-input" class="form-label fw-semibold small">Saved trip file</label>
            <p class="small text-muted mb-2">Choose an .ebirdtrip or JSON backup exported from this app.</p>
            <input id="trip-archive-input" type="file" class="form-control"
              accept=".ebirdtrip,.gz,.json,application/gzip,application/json,text/plain,application/octet-stream" @change="importTrip" :disabled="isImporting || busy" />
          </div>
          <div v-if="isImporting" class="mt-3" role="status">
            <div class="d-flex justify-content-between small mb-1"><span>{{ importStage }}</span><span v-if="importProgress !== null">{{ importProgress }}%</span></div>
            <div class="progress" role="progressbar" :aria-label="importStage" :aria-valuenow="importProgress === null ? undefined : importProgress" aria-valuemin="0" aria-valuemax="100">
              <div class="progress-bar" :class="{ 'progress-bar-striped progress-bar-animated': importProgress === null }" :style="{ width: importProgress === null ? '100%' : `${importProgress}%` }" />
            </div>
          </div>
          <div v-if="pendingImport && importCollision && !isImporting" class="border rounded p-3 mt-3">
            <h3 class="h6">You already have a trip named “{{ pendingImport.trip.name }}”</h3>
            <p v-if="localImportCollision" class="small text-muted">Keep both trips by choosing a different name, or replace the browser copy of the existing trip. Its cloud version is updated only when you save to cloud.</p>
            <p v-else class="small text-muted">A cloud trip with this name is already in your library. Choose a different name to import a separate trip, or open the existing cloud trip from the library.</p>
            <form @submit.prevent="finishImport(false)">
              <label for="import-trip-name" class="form-label small">Name for the imported trip</label>
              <input id="import-trip-name" v-model="importName" class="form-control mb-2" required />
              <p v-if="duplicateImportName" class="small text-danger">Choose a name that is not already in your library.</p>
              <div class="d-flex gap-2 flex-wrap">
                <button class="btn btn-primary btn-sm" :disabled="!importName.trim() || duplicateImportName">Import as a new trip</button>
                <button v-if="localImportCollision" class="btn btn-outline-danger btn-sm" type="button" @click="finishImport(true)">Replace “{{ localImportCollision.name }}” in this browser</button>
              </div>
            </form>
          </div>
          <p v-if="transferStatus" class="small mt-3 mb-0" :class="transferFailed ? 'text-danger' : isExporting ? 'text-muted' : 'text-success'" role="status">{{ transferStatus }}</p>
        </div>
      </section>
    </template>
    <template #trip-actions="{ busy }">
      <div class="d-flex justify-content-between align-items-start gap-3 flex-wrap mb-3">
        <div>
          <div class="small text-muted mb-1">Working on</div>
          <div class="d-flex align-items-center gap-2">
            <h2 class="h4 mb-1">{{ trips.find(trip => trip.id === selectedTripId)?.name }}</h2>
            <button class="btn btn-link text-muted p-1" :disabled="busy" @click="openRenameModal" aria-label="Rename trip" title="Rename trip"><i class="bi bi-pencil" /></button>
          </div>
          <p class="small text-muted mb-0">Last browser edit: {{ formatSyncTimestamp(tripEditTimes[selectedTripId]) || 'date unknown' }}</p>
        </div>
      </div>
      <div class="d-flex gap-2 flex-wrap mb-3">
        <button class="btn btn-outline-secondary btn-sm" :disabled="busy || isExporting" @click="exportTrip">
          <span v-if="isExporting" class="spinner-border spinner-border-sm me-1"></span>Download backup
        </button>
        <button class="btn btn-link text-danger btn-sm" :disabled="busy || isExporting" @click="deleteTrip">Remove from browser</button>
      </div>
      <p v-if="transferStatus" class="small mb-2" :class="transferFailed ? 'text-danger' : isExporting ? 'text-muted' : 'text-success'" role="status">{{ transferStatus }}</p>
      <p v-if="saveStatus" class="small text-success" role="status">{{ saveStatus }}</p>
    </template>
    <template #trip-details>
      <div class="card">
        <div class="card-body">
          <h2 class="h5 card-title">Targets for {{ tripForm.name }}</h2>
          <p class="text-muted small mb-1">
            Sync life lists and trip reports to flag world, region, and trip targets.
          </p>
          <LifeList
            variant="targets"
            :showSummary="false"
            :speciesList="speciesList"
            :region="region"
            @update:speciesList="handleSpeciesListUpdate"
          />
          <div class="row g-2 align-items-start mt-3">
            <div class="col-md-3">
              <label class="form-label fw-semibold mb-1">
                <a
                  class="text-decoration-none"
                  href="https://ebird.org/mytripreports"
                  target="_blank"
                  rel="noopener"
                >
                  <i class="bi bi-car-front-fill text-danger me-1"></i>
                  Trip report
                </a>
              </label>
              <div class="text-muted small">
                Paste the trip report ID to mark species seen on this trip.
              </div>
            </div>
            <div class="col-md-9">
              <div class="input-group">
                <span class="input-group-text">https://ebird.org/tripreport/</span>
                <input
                  v-model="tripForm.tripReportId"
                  class="form-control"
                  @input="persistTripReportId"
                />
                <button
                  class="btn btn-outline-secondary"
                  type="button"
                  @click="syncTripReportSpecies"
                  :disabled="!tripForm.tripReportId || isSyncingTripReport || isClearingTripReport"
                  aria-label="Sync trip report species list"
                >
                  <span v-if="isSyncingTripReport" class="spinner-border spinner-border-sm"></span>
                  <i v-else class="bi bi-arrow-repeat"></i>
                </button>
                <button
                  class="btn btn-sm app-action-btn app-action-btn--danger"
                  type="button"
                  @click="clearTripReportSync"
                  :disabled="!hasTripReportState || isSyncingTripReport || isClearingTripReport"
                  aria-label="Clear trip report ID and synced species status"
                  title="Clear trip report ID and synced species status"
                >
                  <span
                    v-if="isClearingTripReport"
                    class="spinner-border spinner-border-sm"
                    aria-hidden="true"
                  ></span>
                  <i v-else class="bi bi-trash3"></i>
                </button>
              </div>
              <div v-if="isSyncingTripReport || isClearingTripReport" class="progress mt-2" role="progressbar" aria-label="Updating trip report">
                <div class="progress-bar progress-bar-striped progress-bar-animated w-100" />
              </div>
              <div
                v-if="tripReportAlertMessage"
                class="alert py-2 px-3 mt-2 mb-0 small d-flex align-items-center"
                :class="`alert-${tripReportAlertVariant}`"
              >
                <i class="bi me-2" :class="tripReportAlertIcon"></i>
                <div>
                  <div>{{ tripReportAlertMessage }}</div>
                  <div class="text-muted small" v-if="showLastSyncLabel">
                    Last synced: {{ formatSyncTimestamp(lastTripReportSyncTime) }}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-if="totalSpeciesCount" class="mt-3 pt-2 border-top">
            <div class="d-flex flex-wrap gap-3 small">
              <div><strong>Total Species (EBD):</strong> {{ totalSpeciesCount }}</div>
              <div v-if="hasLifeList">
                <router-link
                  :to="worldTargetsLink"
                  class="text-decoration-none text-reset"
                  title="Open species list filtered to world targets"
                >
                  <strong>New for World:</strong>
                  <span class="text-danger fw-semibold ms-1">{{ newWorldCount }}</span>
                </router-link>
              </div>
              <div v-if="hasRegionList">
                <router-link
                  :to="regionTargetsLink"
                  class="text-decoration-none text-reset"
                  title="Open species list filtered to region targets"
                >
                  <strong>New for Region:</strong>
                  <span class="text-danger fw-semibold ms-1">{{ newRegionCount }}</span>
                </router-link>
              </div>
              <div>
                <strong>New for Trip:</strong>
                <span class="text-danger fw-semibold ms-1">{{ newTripCount }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

    </template>
  </CloudTrips>
  <footer class="tech-footer mt-4">
    <div class="tech-footer-links d-flex flex-wrap align-items-center justify-content-center gap-2 small text-muted">
      <span>v{{ appVersion }}</span>
      <span class="tech-footer-divider">•</span>
      <a
        :href="repoUrl"
        target="_blank"
        rel="noopener"
        class="text-decoration-none text-reset d-inline-flex align-items-center gap-1"
      >
        <i class="bi bi-github"></i>
        <span>GitHub</span>
      </a>
      <span class="tech-footer-divider">•</span>
      <a
        :href="sponsorUrl"
        target="_blank"
        rel="noopener"
        class="text-decoration-none text-reset d-inline-flex align-items-center gap-1"
      >
        <i class="bi bi-heart-fill text-warning"></i>
        <span>Sponsor</span>
      </a>
      <span class="tech-footer-divider">•</span>
      <a
        :href="zoziologieUrl"
        target="_blank"
        rel="noopener"
        class="text-decoration-none text-reset d-inline-flex align-items-center gap-1"
        title="Zoziologie"
      >
        <span>Powered by</span>
        <img :src="zoziologieLogoUrl" alt="Zoziologie Logo" class="zoziologie-logo" />
        <span class="fw-semibold">Zoziologie</span>
      </a>
    </div>
  </footer>

  <div v-if="isRenameModalOpen">
    <div
      class="modal fade show"
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      style="display: block"
    >
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">Rename trip</h5>
            <button type="button" class="btn-close" @click="closeRenameModal"></button>
          </div>
          <div class="modal-body">
            <label class="form-label">Trip name</label>
            <input v-model="renameTripName" class="form-control" placeholder="Spring migration" />
            <div class="mt-2" v-if="hasDuplicateRename">
              <small class="text-danger">A trip with this name already exists.</small>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-outline-secondary" type="button" @click="closeRenameModal">
              Cancel
            </button>
            <button
              class="btn btn-primary"
              type="button"
              @click="saveRenameTrip"
              :disabled="!renameTripName.trim() || hasDuplicateRename"
            >
              Rename
            </button>
          </div>
        </div>
      </div>
    </div>
    <div class="modal-backdrop fade show"></div>
  </div>
</template>

<style scoped>
.tech-footer {
  width: 100%;
  padding: 10px 2px 0;
  border-top: 1px solid var(--bs-border-color);
}

.tech-footer-divider {
  opacity: 0.6;
}

.zoziologie-logo {
  height: 14px;
  width: auto;
  display: block;
}
</style>
