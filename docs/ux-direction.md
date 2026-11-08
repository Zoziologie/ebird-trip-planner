# Trip workspace: interaction specification

Status: round 4, 18 October 2026. Review prototype at `/ebird-trip-planner/docs/prototypes/trip-workspace.html`; production app unchanged. Screen, Access and Trip stage are prototype controls. Reload discards edits. Cloud save/share feedback is still simulated, but the Oman plan, EBD data and eBird observations are real cached data.

## Central workspace

The itinerary is the centre of the app. Map and Species share the same stop/full-trip selection. Editors have a persistent details panel in a wider itinerary column and a Preview switch. Visitors have the viewing layout and the label `visitor view`, without save controls. Map remains primary on mobile; the itinerary opens as a bottom sheet. Selecting a stop in visitor/preview collapses the sheet.

The fixture now contains the provided Oman plan: 63 stops across 21 days, 6–26 February 2026. Use its real 1–6-stop daily variation rather than padding it. The original plan has no stop on 23 February even though the report contains observations that day. Days are collapsible; the selected day's stops open together. The denser view uses type icons, a compact time/duration line, and report-checklist badges instead of a repeated status paragraph on every row. Day headings retain stop counts and editor birding/driving summaries. The cached route geometry/time/distance comes from the exported plan, not performed GPS tracks.

## Historical stages

- Before: replay through 5 February; the full plan is future, and no recorded checklists or species are shown. The report URL can be connected in advance.
- During: replay through 16 February, 23:59. Past and future stops are shown alongside actual report checklists available by that date. Select a stop to see the union of its spatially matched checklists. Species totals are lower bounds if some checklist details are missing.
- After: replay through 26 February. Preserve the original itinerary, show the full 353-checklist report and global taxon-list totals, and retain mismatches and off-itinerary locations. Dates never prove completion.

Stage selection is a replay aid, not proposed production navigation. Actual stage can be derived from dates; no mandatory Start/Finish workflow. Refresh does not invent additional results or advance the replay clock. The cached report snapshot was fetched during this review. Refreshing in the prototype reloads that cache and simulates the trip save rather than writing to eBird or Firebase.

## Report connection and recorded lists

The same proxy used by the current app exposes checklists and location coordinates. The previous round's uncertainty is resolved. See [API verification and aggregation](ebird-report-api.md) for endpoint schema, counts, missing observations and the small reusable aggregation operation.

Stop containment is spatial over all report dates up to the replay cutoff, not constrained to the planned visit day. Merge the matching checklist IDs into one list of taxa, retaining per-taxon checklist counts and summed known individuals. Do not add per-stop lists to compute a trip total because stop areas can overlap. Report records outside every planned stop area remain included on the report map and in full-trip results.

Recorded species in visitor/preview are based on these real report observations. Editors can compare Recorded with Historical EBD for a selected stop. Historical reporting rates are explicitly labelled as such, rather than presented as newly calculated trip probabilities. Existing prediction/probability features remain part of production scope; the prototype does not replace their methodology.

Editors configure the report through a short dialog: URL/ID, connection status, Connect or Refresh, Disconnect, Done, and a small eBird management link. This review uses report 468402. Visitor/preview uses a direct `https://ebird.org/tripreport/468402` link; there is no report configuration dialog in that mode. Disconnect never deletes or modifies the report in eBird, and retains the itinerary.

Twenty-four checklist metadata records have no joined observations in the retrieved taxon-detail responses. Show missing coverage, not zero species. Full report totals use the global taxon-list response; partial dates/areas use available joined observations and expose incompleteness. Production needs endpoint error handling and taxonomy reconciliation, not silent fabrication.

## Map layers and visual language

The global system is defined in [map-marker-system.md](map-marker-system.md) and demonstrated by Map key. Type uses a symbol, future/past uses hollow/filled, and selection uses an amber halo while preserving the type and fill. No distinct present marker. Past is not equivalent to visited; checklist evidence is a separate badge.

Report checklists use blue eBird-style location pins: a flame for hotspots, a dot for personal locations. The artwork is derived from Bootstrap Icons, not copied official eBird assets. Nearby checklists cluster into numbered blue circles and expand on zoom/click. The popup links to the actual checklist. The selected stop's circular area is displayed to explain the spatial match; area editing is deferred.

Visitor/preview initially shows planned stops/routes and report checklists only. EBD and species-rate layers are off. The primary Layers selector is hidden; optional Extra layers exposes the analysis tools without making them the default. Available report checklists always remain visible in visitor/preview. Editing starts with historical EBD points enabled and also shows report data when connected.

Editors can configure the species reporting-rate layer in a modal with species, DBSCAN distance and minimum checklists per location. This round computes from the real saved Oman EBD data, not generated sample points. Quantitative rate/effort marks use their own orange scale and do not change stop type/time semantics. Selecting Stop map from a recorded species row returns to the stop's report map; it does not enable a historical species-rate layer for the visitor.

Retain place search, terrain/satellite, fit trip, zoom/bearing and live-position controls. Position requests occur only on user activation; no GPS track recording is introduced. Map control placement and sizing remain a later refinement.

## Editing

Inline details retain name with Auto name, type, date/time, duration, searchable species chips and existing note. Remove radius input and coordinate/location section. Dragging radius/centre and possible polygons are deferred. Observer comments can be addressed separately later. No select/clear toolbar, selection checkboxes or global Compute driving routes action. Per-leg routes remain available.

Shift-click selects a range; Ctrl/Cmd-click toggles membership. Touch hold is the prototype equivalent. Native Tab remains focus traversal. Multi-selection replaces details with a bulk hours/days/weeks shift; negative shifts and Undo remain. Clicking a stop normally returns to individual editing. Imported durations retain the current UI's existing hours convention, despite the historical `durationMin` storage name.

## Saving and collaboration

Offline editing with revision checks and recovery copies is the confirmed v0.5 policy, superseding the earlier single-editor lease proposal. Online editor presence is advisory. Save locally while disconnected and publish on reconnect only against the unchanged base revision. If the cloud changed, durably retain a named local recovery copy before loading the latest shared trip; reconcile manually without silent overwrite or automatic merge. Recovery/export must work offline and without a spare cloud slot. Preview preserves pending edits; friends see the last cloud-published revision. See [the implementation specification](v0.5-implementation.md) for the complete policy.

Stop notes are shared itinerary content. Life/region lists are personal to each account; stop species-of-interest targets are shared. Personal lists and editor presence never appear in visitor data.

Autosave updates the existing shared version without changing access. Separate large datasets from frequently edited records; keep Undo, recoverable deletion, previous versions and recovery export. Validate migration, access revocation, expired sessions, two tabs and stale reconnection before replacing archive saving. Public data must not include private life lists or editor identities. Cached data is not a promise of downloaded map coverage.

## Next implementation boundary

Validate the data aggregation and dense UX now. Production fetching/caching, refresh orchestration, Firebase migration/autosave/revision rules, private-report failures, sensitive-data handling and regression checks are implementation work. Reuse current calculations and exports, and preserve legacy trips throughout migration. The prototype's fixture can be rebuilt using `scripts/prepare_oman_prototype.py`; its source API responses are cached outside the repository.

## Round 4 verification

Checked before/during/after visitor states against the cached report, the direct report link, per-stop spatial aggregation, desktop and 390 × 844 mobile layouts, and the simplified editor dialog. Al Saadah Park matches an independent Haversine calculation (2 checklists, 27 taxa through 16 February). The fixture rebuild matches the saved data except its capture timestamp. JavaScript syntax passes and the browser reported no console errors.

## Round 5: spatial editing and compact planning

Selected stop markers can be dragged, with four draggable handles for a birding area. Keyboard arrows move the selected marker by 100 m (Shift: 1 km) and resize handles by 100 m. Releasing a drag rebuilds report-checklist membership and historical EBD totals/rates from the cached locations. Moving a stop invalidates only its incoming and outgoing route; resizing preserves routes. Undo restores geometry, aggregates and routes. These operations change the plan, never the source eBird checklist coordinates.

Rows are one line: time, type/checklist-evidence icon, name, then an editor drive action. Computed legs show travel minutes as quiet clickable text with distance in the tooltip; uncomputed legs show a Drive button. The itinerary hint, repeated trip subtitle, lifecycle strip and persistent feedback footer are removed from the visible layout. Before/during/after selection remains in the prototype controls. The existing palette is retained for this round.

Historical checklist locations have green hotspot and ochre personal-location colours, a 3–13 px checklist-count scale, and species/checklist totals in the popover. A single map popover follows hover; click pins it to make links usable, empty-map click closes it, and map cursors reset on leave. The report cluster expansion uses the current Mapbox promise API.

Verified Round 5 using real pointer drags: radius 0.50 → 1.60 km retained the 26-minute incoming route; moving the centre outside the original area changed its result from 2 checklists/27 taxa to 0 and cleared both adjacent routes. Undo restored the original geometry and route. Checked pointer hover/click pinning, cursor reset, keyboard edits, and mobile visitor/editor access. Desktop 1280 × 900 and mobile 390 × 844 fit without document overflow; no console errors were reported.

## Round 6: scope, history and integrated details

A compact scope selector beside Itinerary replaces the full-trip row and returns to the previous selected stop. Undo/Redo keeps up to 50 snapshots for plan edits, including fields, targets, geometry, bulk shifts, removal/addition and routes. Continuous typing is grouped; ⌘/Ctrl-Z, ⌘/Ctrl-Shift-Z and Ctrl-Y work, with small touch-accessible controls in the itinerary heading. History remains local to this prototype session.

The stop editor puts the type icon, auto-name icon and name in one row. Date/time and duration use a 2:1 row. Gold #f8ae1c stars match the old app; selected species and search occupy one wrapping input container. There is no Move on map button. Both the itinerary/details divider and sidebar/map divider can be dragged or adjusted with arrows.

The bottom selection panel shows the EBD taxon union, total checklists, location count, and medians of positive checklist duration/distance values. Bulk/full-trip selection deduplicates locations across overlapping areas. Trip-report checklist and species counts are separate, with incomplete coverage labelled. Observer comments from EBD expand within the same panel; preview, copy and Markdown download reuse the production comment exporter and aggregate the selected areas. The source archive’s three malformed comment fields contained trailing EBD rows, excluded at the first newline URN record marker rather than exposed as observation text.

Round 6 verification: field edits were undone in sequence with ⌘-Z and restored with Redo; full-trip scope returned to Al Saadah Park; Osprey was added through the shared selection input; Copy returned success and Download created a Markdown file. Both dividers were exercised (pointer and keyboard). Desktop 1280 × 900 and mobile 390 × 844 fit their document bounds, with no console errors.

## Round 7: optional details and original species workflow

Empty species-of-interest and note fields start as compact + actions, expand on click, and open automatically when populated on a newly selected stop. Full trip is a single action beside Itinerary; choosing a stop restores location scope. Undo/Redo live inside an overflow menu with shortcuts, removing persistent arrow buttons.

Planning species follows SpeciesList.vue: Tax., interest star and Top rank for a selected location; Location rate; Cumulative Trip; full-trip Average Trip and EBD columns; Life/Region/Trip/Interest filters combined as OR; maximum cumulative-trip and minimum location/average-rate sliders; sortable headers; search; CSV export. The fixture preserves the original 459 EBD taxa, taxonomic order and available life-list flags. Trip probabilities use 1 minus the product of visit miss probabilities, adjusted by each stop’s duration. Expected counts sum the selected location rates, or full-trip probabilities, over all taxa before table filters. Source-confirmed report taxa are excluded from remaining life/region targets.

My lists sits in the editor’s Species toolbar, next to the filters it affects. It accepts life and region CSV exports using the existing taxonomy resolver and countable-taxon rules. Archive life flags are retained; no region list is invented. Region expected totals remain — until upload. Uploads/replacements/removal operate in this prototype session; personal-list persistence and account scope belong to production implementation. Visitor/preview retains the simple recorded/planned-target view, with no probabilities or personal-list uploads.

Verified empty-field collapse and non-empty reopening; overflow and keyboard Undo; CSV export; a test region CSV upload/removal; interest filtering from 41 to 3 location taxa with unrestricted probability thresholds; full-trip column switching; alphabetical and rate ordering; common-name search; clean preview access. Independent calculations matched the Al Saadah Park expected total of 15.0 and Booted Eagle’s trip estimate of 83.2398%. Mobile table scrolling and expected-count footer have separate space without overlap or document overflow.
