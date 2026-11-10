<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { mountWorkspace } from './workspace/controller';
import hotspotIcon from './workspace/report-hotspot.svg';
import personalIcon from './workspace/report-personal.svg';
const props = defineProps({
  plan: Object,
  model: Object,
  initialView: String,
  visitor: Boolean,
  invited: Boolean,
  save: Function,
  saveReport: Function,
  saveLists: Function,
});
const root = ref(null);
const mapError = ref(false);
const stopFields = [
  ['datetime-field', 'Date & time'],
  ['duration-field', 'Duration'],
  ['interest-details', 'Species of interest'],
  ['note-details', 'Note'],
  ['historical-stats', 'Historical eBird selection'],
  ['recorded-stats', 'Trip-report results'],
  ['comments-panel', 'Observer comments'],
];
let controller;
onMounted(() => {
  try {
    controller = mountWorkspace(root.value, props.model, {
      initialView: props.initialView,
      visitor: props.visitor,
      invited: props.invited,
      getPlan: () => props.plan,
      onSave: props.save,
      onReport: props.saveReport,
      onLists: props.saveLists,
    });
  } catch (error) {
    if (!/failed to initialize webgl/i.test(error.message)) throw error;
    mapError.value = true;
  }
});
watch(
  () => [props.plan.name, props.plan.timeZone],
  () => controller?.setMetadata(props.plan),
);
onBeforeUnmount(() => controller?.destroy());
defineExpose({
  getPlan: () => controller?.getPlan(),
  replacePlan: (model) => controller?.replacePlan(model),
});
</script>

<template>
  <div ref="root" class="trip-workspace-ui">
    <section v-if="mapError" class="map-error" role="alert">
      <h1>Could not open the map</h1>
      <p>Your browser could not start WebGL, which the trip workspace needs to display the map.</p>
      <p>
        Try reloading the page. If the problem continues, check that hardware acceleration is
        enabled or open the trip in another browser.
      </p>
      <div class="map-error-actions">
        <button class="primary" @click="() => $router.go(0)">Reload</button>
        <router-link to="/trips">My trips</router-link>
      </div>
    </section>
    <div v-show="!mapError" id="workspace-layout" class="app">
      <header class="header">
        <div class="identity">
          <slot name="library" /><span class="brand" aria-label="eBird Trip Planner"
            ><i class="bi bi-feather" aria-hidden="true"></i></span
          ><slot name="trip"
            ><strong>{{ plan.name }}</strong></slot
          ><span class="visitor-only small">visitor view</span>
        </div>
        <nav class="segments" aria-label="Trip view">
          <button id="map-view" aria-pressed="true">Map</button
          ><button id="species-view" aria-pressed="false">Species</button>
        </nav>
        <details class="header-menu">
          <summary aria-label="Trip actions"><i class="bi bi-three-dots"></i></summary>
          <div class="header-actions">
            <a
              id="report-open"
              class="view-report-link"
              href="https://ebird.org/tripreports"
              target="_blank"
              rel="noopener"
              hidden
              >eBird trip report ↗</a
            ><slot name="actions" /><button
              id="settings-open"
              aria-label="Trip settings"
              title="Trip settings"
            >
              <i class="bi bi-gear" aria-hidden="true"></i></button
            ><button id="mode" class="member-only">Preview</button>
          </div>
        </details>
      </header>
      <div class="journey-bar" hidden>
        <div>
          <strong id="journey-stage"></strong><span id="journey-dates" class="small"></span>
        </div>
        <div id="journey-results"></div>
        <span id="sync-label" class="small"></span>
      </div>
      <div class="workspace">
        <aside class="itinerary" aria-label="Itinerary and stop editor">
          <div class="itinerary-head">
            <div>
              <strong id="sheet-title">Itinerary</strong
              ><button id="full-trip" class="scope-action" aria-pressed="false">Full trip</button>
            </div>
            <button id="sheet" aria-expanded="false" aria-label="Open itinerary">
              Open itinerary ↑
            </button>
            <div class="history-tools edit-only">
              <button id="undo" aria-label="Undo" title="Undo · ⌘/Ctrl Z" disabled>
                <i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i></button
              ><button id="redo" aria-label="Redo" title="Redo · ⇧ ⌘/Ctrl Z" hidden>
                <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
              </button>
            </div>
            <button id="add" class="edit-only">+ Stop</button>
          </div>
          <div id="stop-list" class="stop-list"></div>
          <div id="visitor-details" class="visitor-only preview-details"></div>
          <div
            id="detail-split"
            class="detail-split edit-only"
            role="separator"
            aria-label="Resize itinerary and details"
            aria-orientation="horizontal"
            tabindex="0"
          ></div>
          <section id="editor" class="stop-editor edit-only" aria-label="Stop details">
            <div id="single-edit">
              <div class="editor-title">
                <strong>Stop details</strong
                ><button id="remove" aria-label="Remove selected stop">
                  <i class="bi bi-trash3"></i> Remove stop
                </button>
              </div>
              <div id="inline-name-row" class="name-row">
                <span class="type-field"
                  ><i id="type-icon" class="bi bi-feather" aria-hidden="true"></i
                  ><select id="type" aria-label="Stop type" title="Stop type">
                    <option value="Birding">Birding</option>
                    <option value="Accommodation">Accommodation</option>
                    <option value="Waypoint">Waypoint</option>
                    <option value="Food">Food</option>
                    <option value="Airport">Airport</option>
                  </select></span
                >
                <div class="name-field">
                  <input id="name" aria-label="Stop name" title="Click to rename" /><button
                    id="auto-name"
                    aria-label="Auto name from location"
                    title="Auto name from location"
                  >
                    <i class="bi bi-arrow-clockwise"></i>
                  </button>
                </div>
              </div>
              <div id="stop-default-body">
                <div id="default-timing" class="timing-row">
                  <label id="datetime-field"
                    >Date & time
                    <input
                      id="datetime"
                      type="datetime-local"
                      aria-label="Stop date and time" /></label
                  ><label id="duration-field"
                    >Duration · hours
                    <input
                      id="duration"
                      type="number"
                      step="0.25"
                      min="0"
                      aria-label="Duration hours"
                  /></label>
                </div>
              </div>
              <details id="stop-extra-details" class="stop-extra-details">
                <summary>Details</summary>
                <div id="stop-extra-body">
                  <div id="detail-timing" class="timing-row"></div>
                  <details id="interest-details" class="optional-field">
                    <summary>
                      <i class="bi bi-star-fill target-star"></i>
                      <span id="interest-label">Add species of interest</span>
                    </summary>
                    <div class="target-field">
                      <div id="target-chips" class="chips"></div>
                      <input
                        id="target-search"
                        type="search"
                        placeholder="Search and add species…"
                        role="combobox"
                        aria-label="Search species of interest"
                        aria-expanded="false"
                        aria-controls="target-options"
                        aria-autocomplete="list"
                      />
                    </div>
                    <div
                      id="target-options"
                      role="listbox"
                      aria-label="Matching species"
                      hidden
                    ></div>
                  </details>
                  <div id="note-details" class="optional-field">
                    <label for="note">Note</label>
                    <textarea
                      id="note"
                      rows="2"
                      aria-label="Stop notes"
                      placeholder="Add a note"
                    ></textarea>
                  </div>
                </div>
              </details>
            </div>
            <div id="bulk-edit" hidden>
              <strong id="bulk-title"></strong>
              <p class="small">
                Shift every selected stop by the same amount. Negative values move earlier.
              </p>
              <div class="row">
                <input id="shift-amount" type="number" value="1" aria-label="Shift amount" /><select
                  id="shift-unit"
                  aria-label="Shift unit"
                >
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                  <option value="weeks">weeks</option></select
                ><button id="shift" class="primary">Apply shift</button>
              </div>
              <p class="small">
                Day and week shifts preserve local clock times. Click a stop without modifiers to
                return to its details.
              </p>
              <button id="remove-bulk">Remove selected stops</button>
            </div>
          </section>
          <section id="selection-stats" class="selection-stats">
            <div id="stop-stats">
              <div id="historical-stats"></div>
              <div id="recorded-stats"></div>
            </div>
            <div id="comments-panel" class="edit-only">
              <span>Observer list comments</span>
              <div class="comment-actions">
                <button id="copy-comments">Copy</button
                ><button id="download-comments">Download .md</button
                ><span id="comment-feedback" class="sr-only" role="status"></span>
              </div>
            </div>
          </section>
          <span id="feedback" role="status" class="sr-only"></span>
        </aside>
        <div
          id="map-split"
          role="separator"
          aria-label="Resize itinerary width"
          aria-orientation="vertical"
          tabindex="0"
        ></div>
        <main class="main">
          <section id="map-panel" aria-label="Trip map">
            <div id="map"></div>
            <div class="map-search"><div id="geocoder"></div></div>
            <details id="layers" class="layers">
              <summary aria-label="Map layers" title="Map layers">
                <i class="bi bi-layers" aria-hidden="true"></i>
              </summary>
              <div class="layer-body">
                <h3>Map layers</h3>
                <div class="basemap-switch" role="group" aria-label="Basemap">
                  <button id="basemap-map" aria-pressed="true">
                    <img id="basemap-map-image" alt="" loading="lazy" /><span>Map</span></button
                  ><button id="basemap-satellite" aria-pressed="false">
                    <img id="basemap-satellite-image" alt="" loading="lazy" /><span>Satellite</span>
                  </button>
                </div>
                <h4>Overlays</h4>
                <label class="overlay-option"
                  ><input id="hotspots" type="checkbox" checked /><span
                    class="overlay-symbol ebd-hotspot"
                    aria-hidden="true"
                  ></span
                  ><span>eBird hotspots</span></label
                ><label class="overlay-option"
                  ><input id="personal-locations" type="checkbox" checked /><span
                    class="overlay-symbol ebd-personal"
                    aria-hidden="true"
                  ></span
                  ><span>eBird personal locations</span></label
                >
                <div class="overlay-settings">
                  <label class="overlay-option"
                    ><input id="species-layer" type="checkbox" /><span
                      class="overlay-symbol species-rate"
                      aria-hidden="true"
                    ></span
                    ><span>Species reporting rates</span></label
                  ><button
                    id="cluster-settings"
                    aria-label="Species reporting rate settings"
                    title="Species reporting rate settings"
                  >
                    <i class="bi bi-sliders" aria-hidden="true"></i>
                  </button>
                </div>
                <span id="cluster-status" class="sr-only" role="status"
                  >Choose a species and compute clusters</span
                ><label class="overlay-option report-layer-option"
                  ><input id="report-layer" type="checkbox" /><img
                    :src="hotspotIcon"
                    class="overlay-report-icon"
                    alt=""
                  /><span>Trip-report checklists</span></label
                ><span id="report-layer-status" class="sr-only"></span>
              </div>
            </details>
            <div id="map-tools" class="map-tools mapboxgl-ctrl mapboxgl-ctrl-group">
              <button id="fit" aria-label="Fit trip" title="Fit trip">
                <i class="bi bi-arrows-fullscreen" aria-hidden="true"></i></button
              ><button id="key-open" aria-label="Map key" title="Map key">
                <i class="bi bi-info-lg" aria-hidden="true"></i>
              </button>
            </div>
          </section>
          <section id="species-panel" hidden>
            <div id="species-filters" class="species-filters edit-only">
              <div class="lifer-filters">
                <strong>Filters</strong
                ><label
                  ><input id="filter-life" type="checkbox" />
                  <i class="bi bi-globe2 lifer-icon" aria-hidden="true"></i> Life</label
                ><label
                  ><input id="filter-region" type="checkbox" />
                  <i class="bi bi-geo-alt-fill lifer-icon" aria-hidden="true"></i> Region</label
                ><label
                  ><input id="filter-trip" type="checkbox" />
                  <i class="bi bi-car-front-fill lifer-icon" aria-hidden="true"></i> Trip</label
                ><label
                  ><input id="filter-interest" type="checkbox" />
                  <i class="bi bi-star-fill target-star" aria-hidden="true"></i> Interest</label
                ><span id="species-evidence" class="small"></span>
              </div>
              <div class="probability-filters">
                <label
                  >Cum. Trip (max)
                  <input
                    id="max-trip"
                    aria-label="Maximum cumulative trip probability"
                    type="range"
                    min="0"
                    max="1"
                    step=".01"
                    value=".95"
                  /><output id="max-trip-label">95%</output></label
                ><label
                  ><span id="min-rate-name">Location (min)</span
                  ><input
                    id="min-rate"
                    aria-label="Minimum location or average trip rate"
                    type="range"
                    min="0"
                    max="1"
                    step=".01"
                    value=".05"
                  /><output id="min-rate-label">5%</output></label
                >
              </div>
            </div>
            <div class="species-table-scroll">
              <table>
                <thead id="species-columns"></thead>
                <tbody id="species-rows"></tbody>
              </table>
            </div>
            <div id="expected-summary" class="expected-summary edit-only"></div>
            <p class="small" id="report-status"></p>
          </section>
        </main>
      </div>
    </div>
    <dialog id="settings-dialog" aria-labelledby="settings-title">
      <div class="settings-heading">
        <h2 id="settings-title">Trip settings</h2>
        <button id="settings-close" aria-label="Close settings">
          <i class="bi bi-x-lg" aria-hidden="true"></i>
        </button>
      </div>
      <section class="settings-section edit-only">
        <h3>Trip</h3>
        <slot name="trip-options" />
      </section>
      <section class="settings-section edit-only">
        <h3>eBird</h3>
        <div class="list-upload">
          <strong>Life list</strong><span id="life-list-status" class="small"></span>
          <label class="file-button"
            >Import CSV<input id="life-upload" type="file" accept=".csv,text/csv" /></label
          ><button id="life-clear">Remove</button>
        </div>
        <div class="list-upload">
          <strong>Region list</strong><span id="region-list-status" class="small"></span>
          <label class="file-button"
            >Import CSV<input id="region-upload" type="file" accept=".csv,text/csv" /></label
          ><button id="region-clear">Remove</button>
        </div>
        <p id="list-feedback" role="status" class="small"></p>
        <label for="report-link">eBird trip report</label>
        <div class="settings-input-action">
          <input id="report-link" placeholder="Trip report link or ID" /><button id="sync-report">
            Sync</button
          ><button id="disconnect-report">Remove</button>
        </div>
        <div id="report-summary" class="small"></div>
        <p id="report-progress" role="status" class="small"></p>
        <a class="small" href="https://ebird.org/mytripreports" target="_blank" rel="noopener"
          >Find your eBird trip report ↗</a
        >
      </section>
      <section class="settings-section">
        <h3>Map</h3>
        <label class="preference-row" for="map-style"
          >Map style<select id="map-style">
            <option value="outdoors-v12">Outdoor</option>
            <option value="streets-v12">Streets</option>
            <option value="light-v11">Light</option>
          </select></label
        >
        <p class="small">
          Used by the Map tile in the layer menu. Satellite remains a separate choice.
        </p>
      </section>
      <section class="settings-section edit-only">
        <h3>Stop display</h3>
        <p class="small">
          Default: visible in the editor · Details: collapsed · Hidden: not shown. Saved on this
          device.
        </p>
        <label
          v-for="[id, label] in stopFields"
          :key="id"
          class="preference-row"
          :for="'display-' + id"
          >{{ label
          }}<select :id="'display-' + id">
            <option value="default">Default</option>
            <option value="detail">Details</option>
            <option value="hidden">Hidden</option>
          </select></label
        ><button id="reset-display">Reset display preferences</button>
      </section>
    </dialog>
    <dialog id="key-dialog">
      <h2>Map key</h2>
      <div class="key-types">
        <span><i class="bi bi-feather"></i> Birding</span
        ><span><i class="bi bi-house-door"></i> Stay</span
        ><span><i class="bi bi-airplane"></i> Airport</span
        ><span><i class="bi bi-cup-hot"></i> Food</span
        ><span><i class="bi bi-geo-alt"></i> Waypoint</span>
      </div>
      <div class="key-states">
        <span
          ><span class="stop-symbol future"><i class="bi bi-feather"></i></span> Future stop</span
        ><span
          ><span class="stop-symbol past"><i class="bi bi-feather"></i></span> Past stop</span
        ><span
          ><span class="stop-symbol future selected"><i class="bi bi-feather"></i></span> Selected
          stop</span
        >
      </div>
      <p class="small">
        Fill indicates time, not whether you visited. A checklist badge is separate evidence.
      </p>
      <div class="key-types">
        <span><img :src="hotspotIcon" alt="" /> eBird hotspot</span
        ><span><img :src="personalIcon" alt="" /> Personal checklist location</span>
      </div>
      <p class="small">
        Blue pins are report checklists; nearby pins cluster into a numbered blue circle. Historical
        EBD locations use green for hotspots and ochre for personal locations; size indicates
        checklist count. Species reporting rates use their own orange scale.
      </p>
      <button id="key-close" class="primary">Done</button>
    </dialog>
    <dialog id="cluster-dialog">
      <h2>Species reporting-rate map</h2>
      <p class="small">Historical EBD locations, grouped by distance.</p>
      <label for="cluster-species">Species</label
      ><select id="cluster-species"></select>
      <div class="form-grid">
        <label
          >Clustering distance · km<input
            id="cluster-distance"
            type="number"
            min="0.01"
            max="10"
            step="0.1"
            value="1" /></label
        ><label
          >Minimum checklists per location<input
            id="cluster-minimum"
            type="number"
            min="1"
            max="100"
            value="5"
        /></label>
      </div>
      <p id="cluster-progress" role="status">Uses your historical EBD export.</p>
      <div class="dialog-actions">
        <button id="close-clusters">Cancel</button
        ><button id="compute-clusters" class="primary">Compute reporting rates</button>
      </div>
    </dialog>
  </div>
</template>

<style src="./workspace/workspace.css"></style>

<style src="./workspace/c3.css"></style>
