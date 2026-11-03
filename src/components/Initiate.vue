<template>
  <p class="text-muted small">
    To create a new trip, download the
    <a href="https://ebird.org/data/download" target="_blank">eBird Basic Dataset (EBD)</a>
    and load one or more .zip or .txt files below. Processing happens locally in your browser.
  </p>
  <div class="row">
    <div class="col">
      <input
        type="file"
        id="fileInput"
        @change="handleFileUpload"
        accept=".txt,.zip"
        multiple
        ref="fileInput"
        class="form-control"
        :disabled="disabled || isImporting || isProcessing"
      />
      <div v-if="isImporting" class="mt-2">
        <div v-if="importPhase === 'Reading data'" class="progress">
          <div
            class="progress-bar"
            role="progressbar"
            :aria-valuenow="Math.floor(readingFileProgress)"
            aria-valuemin="0"
            aria-valuemax="100"
            :style="{ width: readingFileProgress + '%' }"
          >
            {{ Math.floor(readingFileProgress) }}% read
          </div>
        </div>
        <div v-else class="d-flex align-items-center gap-2 small text-muted">
          <span class="spinner-border spinner-border-sm" aria-hidden="true"></span>
          {{ importPhase }}
        </div>
        <div class="d-flex justify-content-between small text-muted mt-1">
          <span>{{ readingFileStatus }}</span>
          <span>{{ importElapsed }}</span>
        </div>
      </div>

      <!-- Success message - only after raw data is loaded -->
      <div
        v-if="loadedRecordCount > 0 && !isImporting && !hasError"
        class="alert alert-success alert-dismissible mt-1 py-1"
      >
        <i class="bi bi-check-circle-fill me-2"></i>
        <strong>Success!</strong>
        {{ readingFileStatus }}
      </div>

      <!-- Error message -->
      <div v-if="hasError && !saveStatus" class="alert alert-danger mt-3">
        <i class="bi bi-exclamation-triangle-fill me-2"></i>
        <strong>Processing failed!</strong>
        {{
          readingFileStatus ||
          'An error occurred while processing your file. Please check the file format and try again.'
        }}
      </div>
    </div>
  </div>
  <div class="row">
    <div class="col" v-if="availableYears.min !== null">
      <!-- State/Province Filters -->
      <div v-if="availableStates.length > 1">
        <label for="stateFilter" class="form-label fw-semibold">State/Province</label>
        <select
          id="stateFilter"
          v-model="filters.state"
          :disabled="isProcessing"
          class="form-select form-select-sm"
          multiple
          size="4"
        >
          <option v-for="state in availableStates" :key="state.code" :value="state.code">
            {{ state.name }}
          </option>
        </select>
      </div>
      <!-- County Filters -->

      <div v-if="availableCounties.length > 1">
        <label for="countyFilter" class="form-label fw-semibold">County</label>
        <select
          id="countyFilter"
          v-model="filters.county"
          :disabled="isProcessing"
          class="form-select form-select-sm"
          multiple
          size="4"
        >
          <option v-for="county in availableCounties" :key="county.code" :value="county.code">
            {{ county.name }}
          </option>
        </select>
        <small class="text-muted">Hold Ctrl/Cmd to select multiple counties</small>
      </div>
    </div>
    <div class="col" v-if="availableYears.min !== null">
      <!-- Year Range Filter -->
      <label for="yearMinFilter" class="form-label fw-semibold">Year</label>
      <div class="row g-2 mb-3">
        <div class="col">
          <input
            type="number"
            id="yearMinFilter"
            v-model.number="filters.minYear"
            :disabled="isProcessing"
            class="form-control form-control-sm"
            placeholder="Min"
            :min="availableYears.min"
            :max="availableYears.max"
          />
        </div>
        <div class="col">
          <input
            type="number"
            id="yearMaxFilter"
            v-model.number="filters.maxYear"
            :disabled="isProcessing"
            class="form-control form-control-sm"
            placeholder="Max"
            :min="availableYears.min"
            :max="availableYears.max"
          />
        </div>
      </div>

      <!-- Month Range Filter -->
      <label for="monthMinFilter" class="form-label fw-semibold">Month</label>
      <div class="row g-2">
        <div class="col">
          <select
            id="monthMinFilter"
            v-model.number="filters.minMonth"
            :disabled="isProcessing"
            class="form-select form-select-sm"
          >
            <option :value="null">Min</option>
            <option v-for="month in months" :key="month.value" :value="month.value">
              {{ month.label }}
            </option>
          </select>
        </div>
        <div class="col">
          <select
            id="monthMaxFilter"
            v-model.number="filters.maxMonth"
            :disabled="isProcessing"
            class="form-select form-select-sm"
          >
            <option :value="null">Max</option>
            <option v-for="month in months" :key="month.value" :value="month.value">
              {{ month.label }}
            </option>
          </select>
        </div>
      </div>
    </div>
  </div>
  <!-- Process Button -->
  <div class="row mt-3" v-if="loadedRecordCount > 0 && !isImporting">
    <div class="col-12"><slot name="trip-details" /></div>
    <p class="text-muted">
      Select the region(s) and time range of interest. Both complete and incomplete checklists are
      kept, but reporting rates use complete checklists by default.
    </p>
    <div class="col-auto d-flex align-items-center gap-3">
      <button
        @click="processChecklists"
        class="btn btn-primary"
        :disabled="disabled || isProcessing || !canCreate"
      >
        <span v-if="isProcessing" class="spinner-border spinner-border-sm me-2"></span>
        {{ isProcessing ? 'Processing data…' : submitLabel }}
      </button>
    </div>
    <div class="col-auto d-flex align-items-end">
      <small class="text-muted" v-if="checklists && checklists.length > 0">
        {{ checklists.length.toLocaleString() }} checklists filtered
      </small>
    </div>
  </div>
  <div class="row mt-3" v-if="saveStatus">
    <div class="col">
      <div
        :class="[
          'alert',
          hasError ? 'alert-danger' : isProcessing ? 'alert-info' : 'alert-success',
          'py-2',
          'mb-0',
        ]"
      >
        {{ saveStatus }}
        <template v-if="isProcessing">
          <div class="small mb-1">Step {{ processingStep }} of 5</div>
          <div class="progress mt-2">
            <div
              class="progress-bar"
              role="progressbar"
              :aria-valuenow="Math.floor(processingProgress)"
              aria-valuemin="0"
              aria-valuemax="100"
              :style="{ width: processingProgress + '%' }"
            >
              {{ Math.floor(processingProgress) }}%
            </div>
          </div>
          <div class="d-flex justify-content-between small mt-1">
            <span v-if="processingTotal > 0">
              {{ processingCompleted.toLocaleString() }} of {{ processingTotal.toLocaleString() }}
              {{ processingUnit }}
            </span>
            <span v-else class="d-flex align-items-center gap-2">
              <span class="spinner-border spinner-border-sm" aria-hidden="true"></span>
              Finalizing trip
            </span>
            <span>{{ processingElapsed }}</span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script>
import { nextTick, onBeforeUnmount, ref, reactive, shallowRef, watch } from 'vue';
import JSZip from 'jszip';
import {
  taxonomyByScientificName as taxonomy_sci,
  taxonomyByCode as taxonomy_code,
} from '../utils/taxonomy';
import {
  createEbdImportAccumulator,
  finalizeEbdImport,
  streamEbdZipEntry,
  streamEbdTextFile,
} from '../utils/ebdImport';

export default {
  emits: ['busy'],
  props: {
    canCreate: { type: Boolean, default: true },
    createTrip: { type: Function, required: true },
    submitLabel: { type: String, default: 'Create Trip' },
    disabled: {
      type: Boolean,
      default: false,
    },
  },
  setup(props, { emit }) {
    const fileInput = ref(null);
    const uploadedFiles = ref([]);

    // File reading state
    const readingFileProgress = ref(0);
    const readingFileStatus = ref('');
    const isImporting = ref(false);
    const importPhase = ref('');
    const importElapsed = ref('0:00');
    const hasError = ref(false);
    const loadedRecordCount = ref(0);
    const loadedChecklists = shallowRef([]);

    // Checklists
    const isProcessing = ref(false);
    const processingProgress = ref(0);
    const processingStep = ref(1);
    watch([isImporting, isProcessing], ([reading, creating]) => emit('busy', reading || creating));
    const processingCompleted = ref(0);
    const processingTotal = ref(0);
    const processingUnit = ref('checklists');
    const processingElapsed = ref('0:00');
    const checklists = shallowRef([]);
    const locations = shallowRef([]);
    const speciesList = shallowRef([]);
    const saveStatus = ref('');

    const availableStates = ref([]);
    const availableCounties = ref([]);
    const availableYears = ref({ min: null, max: null });

    const months = [
      { value: 1, label: 'January' },
      { value: 2, label: 'February' },
      { value: 3, label: 'March' },
      { value: 4, label: 'April' },
      { value: 5, label: 'May' },
      { value: 6, label: 'June' },
      { value: 7, label: 'July' },
      { value: 8, label: 'August' },
      { value: 9, label: 'September' },
      { value: 10, label: 'October' },
      { value: 11, label: 'November' },
      { value: 12, label: 'December' },
    ];

    const filters = reactive({
      minYear: null,
      maxYear: null,
      minMonth: 1,
      maxMonth: 12,
      state: [],
      county: [],
    });

    let operationStartedAt = 0;
    let elapsedTimer = null;

    const formatElapsed = (milliseconds) => {
      const totalSeconds = Math.floor(milliseconds / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
    };

    const startElapsedTimer = (target) => {
      operationStartedAt = performance.now();
      target.value = '0:00';
      elapsedTimer = window.setInterval(() => {
        target.value = formatElapsed(performance.now() - operationStartedAt);
      }, 250);
    };

    const stopElapsedTimer = (target) => {
      target.value = formatElapsed(performance.now() - operationStartedAt);
      window.clearInterval(elapsedTimer);
      elapsedTimer = null;
      return target.value;
    };

    onBeforeUnmount(() => window.clearInterval(elapsedTimer));

    const yieldToBrowser = () => new Promise((resolve) => window.setTimeout(resolve, 0));

    const clearLoadedResults = () => {
      loadedRecordCount.value = 0;
      loadedChecklists.value = [];
      checklists.value = [];
      locations.value = [];
      speciesList.value = [];
      availableStates.value = [];
      availableCounties.value = [];
      availableYears.value = { min: null, max: null };
      filters.minYear = null;
      filters.maxYear = null;
      filters.minMonth = 1;
      filters.maxMonth = 12;
      filters.state = [];
      filters.county = [];
    };

    const resetLoadedData = () => {
      clearLoadedResults();
      uploadedFiles.value = [];
      readingFileProgress.value = 0;
      if (fileInput.value) fileInput.value.value = '';
    };

    const finalizeImport = (accumulator) => {
      const result = finalizeEbdImport(accumulator);
      loadedChecklists.value = result.checklists;
      loadedRecordCount.value = result.recordCount;
      availableCounties.value = result.counties;
      availableStates.value = result.states;
      availableYears.value = { min: result.minYear, max: result.maxYear };
      filters.minYear = result.minYear;
      filters.maxYear = result.maxYear;
      readingFileStatus.value =
        `Loaded ${result.recordCount.toLocaleString()} records into ` +
        `${loadedChecklists.value.length.toLocaleString()} checklists.`;
      readingFileProgress.value = 0;
    };

    const handleFileUpload = async (event) => {
      const files = Array.from(event.target.files || []);
      if (files.length === 0) return;
      clearLoadedResults();
      saveStatus.value = '';

      const invalidFile = files.find((file) => !/\.(txt|zip)$/i.test(file.name));
      if (invalidFile) {
        alert('Please select only .txt or .zip files');
        event.target.value = '';
        uploadedFiles.value = [];
        return;
      }

      uploadedFiles.value = files;
      await readFiles();
    };

    const readFiles = async () => {
      if (uploadedFiles.value.length === 0) return;

      clearLoadedResults();
      saveStatus.value = '';
      isImporting.value = true;
      importPhase.value = 'Opening files';
      readingFileProgress.value = 0;
      readingFileStatus.value = 'Starting file reading...';
      hasError.value = false;
      startElapsedTimer(importElapsed);

      const accumulator = createEbdImportAccumulator(taxonomy_sci, taxonomy_code);
      const files = uploadedFiles.value;
      const totalBytes = files.reduce((total, file) => total + file.size, 0);
      let completedBytes = 0;

      try {
        for (const [index, file] of files.entries()) {
          const updateProgress = (fileProgress) => {
            readingFileProgress.value =
              ((completedBytes + Math.min(Math.max(fileProgress, 0), 1) * file.size) / totalBytes) *
              100;
            readingFileStatus.value =
              `Reading file ${index + 1} of ${files.length} ` +
              `(${accumulator.recordCount.toLocaleString()} non-zero records read)`;
          };

          if (file.name.toLowerCase().endsWith('.txt')) {
            importPhase.value = 'Reading data';
            await streamEbdTextFile(file, accumulator, updateProgress);
            completedBytes += file.size;
            continue;
          }

          importPhase.value = 'Opening files';
          readingFileStatus.value = `Opening ZIP ${index + 1} of ${files.length}...`;
          const zip = await JSZip.loadAsync(file);
          const largestTxtFile = Object.values(zip.files).reduce((largest, entry) => {
            if (!entry.name.toLowerCase().endsWith('.txt') || !entry._data) return largest;
            return !largest || entry._data.uncompressedSize > largest._data.uncompressedSize
              ? entry
              : largest;
          }, null);
          if (!largestTxtFile) throw new Error(`No .txt file found in ${file.name}.`);

          importPhase.value = 'Reading data';
          await streamEbdZipEntry(largestTxtFile, accumulator, (progress) => {
            updateProgress(progress / 100);
          });
          completedBytes += file.size;
        }

        readingFileProgress.value = 100;
        importPhase.value = 'Finalizing data';
        readingFileStatus.value = 'Finalizing data...';
        await nextTick();
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
        finalizeImport(accumulator);
        const elapsed = stopElapsedTimer(importElapsed);
        readingFileStatus.value = `${readingFileStatus.value} Imported in ${elapsed}.`;
        isImporting.value = false;
      } catch (error) {
        console.error('File reading error:', error);
        stopElapsedTimer(importElapsed);
        isImporting.value = false;
        importPhase.value = '';
        readingFileProgress.value = 0;
        readingFileStatus.value = error?.message || 'Error occurred while reading the files';
        hasError.value = true;
        checklists.value = null;
        uploadedFiles.value = [];
        if (fileInput.value) fileInput.value.value = '';
      }
    };

    const updateProcessingProgress = (completed, total, unit) => {
      processingCompleted.value = completed;
      processingTotal.value = total;
      processingUnit.value = unit;
      processingProgress.value =
        ((processingStep.value - 1 + (total ? completed / total : 0)) / 5) * 100;
    };

    const processChecklists = async () => {
      if (loadedChecklists.value.length === 0) return;

      isProcessing.value = true;
      hasError.value = false;
      processingStep.value = 1;
      startElapsedTimer(processingElapsed);
      saveStatus.value = 'Filtering checklists...';
      locations.value = [];
      speciesList.value = [];
      const filteredChecklists = [];
      const sourceChecklists = loadedChecklists.value;
      const chunkSize = 1000;
      updateProcessingProgress(0, sourceChecklists.length, 'checklists');

      for (let start = 0; start < sourceChecklists.length; start += chunkSize) {
        const end = Math.min(start + chunkSize, sourceChecklists.length);
        for (let index = start; index < end; index += 1) {
          const checklist = sourceChecklists[index];
          const rowDate = new Date(checklist.date);
          const rowYear = rowDate.getFullYear();
          const rowMonth = rowDate.getMonth() + 1;

          if (filters.minYear && rowYear < filters.minYear) continue;
          if (filters.maxYear && rowYear > filters.maxYear) continue;

          if (filters.minMonth && filters.maxMonth) {
            if (filters.minMonth <= filters.maxMonth) {
              if (rowMonth < filters.minMonth || rowMonth > filters.maxMonth) continue;
            } else {
              if (rowMonth < filters.minMonth && rowMonth > filters.maxMonth) continue;
            }
          }

          if (filters.state.length > 0 && !filters.state.includes(checklist.location.state_code))
            continue;
          if (filters.county.length > 0 && !filters.county.includes(checklist.location.county_code))
            continue;

          filteredChecklists.push(checklist);
        }
        updateProcessingProgress(end, sourceChecklists.length, 'checklists');
        await yieldToBrowser();
      }

      checklists.value = filteredChecklists;
      try {
        await processLocations();
      } catch (error) {
        saveStatus.value = `Trip creation failed: ${error.message}`;
        hasError.value = true;
        stopElapsedTimer(processingElapsed);
        isProcessing.value = false;
      }
    };

    const processLocations = async () => {
      processingStep.value = 2;
      saveStatus.value = 'Building locations...';
      const locationMap = new Map();
      const sourceChecklists = checklists.value;
      const chunkSize = 1000;
      updateProcessingProgress(0, sourceChecklists.length, 'checklists');

      for (let start = 0; start < sourceChecklists.length; start += chunkSize) {
        const end = Math.min(start + chunkSize, sourceChecklists.length);
        for (let index = start; index < end; index += 1) {
          const checklist = sourceChecklists[index];
          if (!checklist.location) continue;
          const localityId = checklist.location.locality_id;

          let location = locationMap.get(localityId);
          if (!location) {
            location = {
              locality_id: localityId,
              latitude: Number(checklist.location.latitude),
              longitude: Number(checklist.location.longitude),
              locality: checklist.location.locality || '',
              locality_hotspot: checklist.location.locality_hotspot || false,
              country: checklist.location.country || '',
              country_code: checklist.location.country_code || '',
              state: checklist.location.state || '',
              state_code: checklist.location.state_code || '',
              county: checklist.location.county || '',
              county_code: checklist.location.county_code || '',
              checklist_count: 0,
              checklist_count_complete: 0,
              checklist_count_incomplete: 0,
              speciesChecklistCounts: new Map(),
              checklist: [],
            };
            locationMap.set(localityId, location);
          }

          const isComplete = checklist.all_species_reported === true;
          if (isComplete) {
            location.checklist_count_complete += 1;
          } else {
            location.checklist_count_incomplete += 1;
          }
          location.checklist_count = location.checklist_count_complete;

          if (isComplete) {
            for (const entry of checklist.species || []) {
              const code = entry.code;
              if (!code) continue;
              location.speciesChecklistCounts.set(
                code,
                (location.speciesChecklistCounts.get(code) || 0) + 1,
              );
            }
          }
          if (isComplete) {
            location.checklist.push({
              checklist_id: checklist.checklist_id,
              date: checklist.date,
              time: checklist.time,
              duration_minutes: checklist.duration_minutes,
              effort_distance_km: checklist.effort_distance_km,
              all_species_reported: true,
              species: checklist.species,
            });
          }
        }
        updateProcessingProgress(end, sourceChecklists.length, 'checklists');
        await yieldToBrowser();
      }

      locations.value = Array.from(locationMap.values());
      await processSpecies();
    };

    const processSpecies = async () => {
      processingStep.value = 3;
      saveStatus.value = 'Building species list...';
      const speciesSet = new Set();
      const sourceLocations = locations.value;
      const chunkSize = 1000;
      updateProcessingProgress(0, sourceLocations.length, 'locations');

      for (let start = 0; start < sourceLocations.length; start += chunkSize) {
        const end = Math.min(start + chunkSize, sourceLocations.length);
        for (let index = start; index < end; index += 1) {
          const location = sourceLocations[index];
          for (const code of location.speciesChecklistCounts.keys()) {
            speciesSet.add(code);
          }
        }
        updateProcessingProgress(end, sourceLocations.length, 'locations');
        await yieldToBrowser();
      }

      speciesList.value = Array.from(speciesSet)
        .map((code) => {
          const taxInfo = taxonomy_code[code];
          return {
            code: code,
            taxonOrder: taxInfo?.taxonOrder || Infinity,
            commonName: taxInfo?.comName || code,
            scientificName: taxInfo?.sciName || '',
          };
        })
        .sort((a, b) => a.taxonOrder - b.taxonOrder);

      processingStep.value = 4;
      saveStatus.value = 'Preparing trip data...';
      await yieldToBrowser();
      await processDone();
    };

    const buildSerializableFilters = () => ({
      minYear: filters.minYear,
      maxYear: filters.maxYear,
      minMonth: filters.minMonth,
      maxMonth: filters.maxMonth,
      state: Array.isArray(filters.state) ? [...filters.state] : [],
      county: Array.isArray(filters.county) ? [...filters.county] : [],
    });

    const processDone = async () => {
      const region = { code: '', name: '' };
      const uniqueStates = new Set();
      const uniqueCountries = new Set();

      // Only "is there exactly one?" matters, so stop as soon as both are
      // ambiguous rather than walking every checklist.
      for (const checklist of checklists.value) {
        if (!checklist.location) continue;
        uniqueStates.add(checklist.location.state_code);
        uniqueCountries.add(checklist.location.country_code);
        if (uniqueStates.size > 1 && uniqueCountries.size > 1) break;
      }

      if (uniqueStates.size === 1) {
        const stateCode = Array.from(uniqueStates)[0];
        const stateInfo = checklists.value[0]?.location;
        region.name = stateInfo?.state || '';
        region.code = stateCode;
      } else if (uniqueCountries.size === 1) {
        const countryCode = Array.from(uniqueCountries)[0];
        const countryInfo = checklists.value[0]?.location;
        region.name = countryInfo?.country || '';
        region.code = countryCode;
      }

      // Checklists are split out of the location records: they are the bulk of a
      // trip but are only read by the species-map popup and the KML export, so
      // they live in their own table and load on demand. Effort values stay behind
      // because the visit summary needs medians across every location in range,
      // which cannot be recovered from per-location medians.
      const preparedLocations = locations.value;
      const checklistsByLocation = [];
      updateProcessingProgress(0, preparedLocations.length + checklists.value.length, 'records');
      for (const [index, location] of preparedLocations.entries()) {
        location.species_checklist_counts = Array.from(location.speciesChecklistCounts.entries());
        delete location.speciesChecklistCounts;

        const entries = Array.isArray(location.checklist) ? location.checklist : [];
        const durations = [];
        const distances = [];
        for (const entry of entries) {
          const minutes = Number(entry?.duration_minutes);
          if (Number.isFinite(minutes) && minutes > 0) durations.push(minutes);
          const kilometers = Number(entry?.effort_distance_km);
          if (Number.isFinite(kilometers) && kilometers > 0) distances.push(kilometers);
        }
        location.checklist_durations = durations;
        location.checklist_distances_km = distances;
        checklistsByLocation.push({ localityId: location.locality_id, checklist: entries });
        delete location.checklist;
        if (index % 1000 === 0) {
          updateProcessingProgress(
            index + 1,
            preparedLocations.length + checklists.value.length,
            'records',
          );
          await yieldToBrowser();
        }
      }

      // The comment corpus is built from the filtered checklists rather than from
      // the locations, so notes on incomplete checklists survive: they are left
      // out of every statistic on purpose, but "what is birding here like" is
      // exactly the question they answer.
      const commentEntries = [];
      for (const [index, checklist] of checklists.value.entries()) {
        if (index % 1000 === 0) {
          updateProcessingProgress(
            preparedLocations.length + index,
            preparedLocations.length + checklists.value.length,
            'records',
          );
          await yieldToBrowser();
        }
        const speciesComments = checklist.species_comments || [];
        const checklistComment = checklist.checklist_comment || '';
        if (!checklistComment && !speciesComments.length) continue;
        commentEntries.push({
          checklist_id: checklist.checklist_id,
          locality_id: checklist.location?.locality_id || '',
          date: checklist.date || '',
          time: checklist.time || '',
          duration_minutes: checklist.duration_minutes,
          checklist_comment: checklistComment,
          species_comments: speciesComments,
        });
      }

      const payload = {
        speciesList: speciesList.value.map((species) => ({ ...species })),
        locations: preparedLocations,
        checklists: checklistsByLocation,
        comments: commentEntries,
        region,
        filters: buildSerializableFilters(),
      };
      processingStep.value = 5;
      saveStatus.value = 'Saving trip in this browser…';
      updateProcessingProgress(0, 5, 'save steps');
      await yieldToBrowser();
      await props.createTrip(payload, updateProcessingProgress);
      processingProgress.value = 100;
      resetLoadedData();
      readingFileStatus.value = 'Trip created. Import data cleared from memory.';
      saveStatus.value = '';
      stopElapsedTimer(processingElapsed);
      isProcessing.value = false;
    };

    return {
      uploadedFiles,
      fileInput,
      readingFileProgress,
      readingFileStatus,
      isImporting,
      importPhase,
      importElapsed,
      hasError,
      checklists,
      loadedRecordCount,
      isProcessing,
      processingProgress,
      processingStep,
      processingCompleted,
      processingTotal,
      processingUnit,
      processingElapsed,
      handleFileUpload,
      readFiles,
      processChecklists,
      availableStates,
      availableCounties,
      availableYears,
      months,
      filters,
      saveStatus,
    };
  },
};
</script>
