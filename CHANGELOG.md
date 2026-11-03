# Changelog

## 2.0.0-beta.2 — 2026-11-03

- Require eBird data when creating trips and support adding it to older trips that lack a dataset.
- Detect the trip time zone from its first scheduled stop, with an optional override that preserves entered local times.
- Compact road geometries while retaining detailed route ends, and raise the workspace plan size limit to 900 KiB.
- Streamline trip settings, report and list controls, and improve cloud setup and offline failure handling.
- Expand cloud rules and browser tests, update allowed storage origins, and add a stable v2 release checklist.

The beta limitations below still apply, except that new trips now require eBird data. See the [release checklist](docs/v2-release-checklist.md) for outstanding scope decisions and validation.

## 2.0.0-beta.1 — 2026-10-19

First beta of the second-generation eBird Trip Planner. The previous published version is 0.4.0; it has not been renamed or retagged.

### New experience

- My trips library for empty-trip creation, historical EBD import, backup import/export, and device/cloud trip management.
- One trip workspace with Map and Species views, compact inline stop editing, bulk time shifts, multi-step undo/redo, draggable stop locations and resizable areas.
- Mineral theme, responsive mobile itinerary, visitor preview, centralized settings and configurable stop-field visibility.
- Separate hotspot/personal-location overlays, species reporting-rate clusters, trip-report checklist pins, and Map/Satellite switching.
- eBird report connection and manual refresh, spatial checklist aggregation, personal target lists, stop targets and notes, and observer-comment copy/download.

### Saving and sharing

- Device autosave and offline editing; cloud-enabled trips sync their compact itinerary separately from the source dataset.
- Visitor links and invited co-traveler editing, with revision checks and persistent device recovery copies for conflicting edits.
- Existing local trips and v1–v3 archives remain readable. Imports create separate trips. Older cloud archives open unchanged and can be explicitly upgraded by their owner.
- Backups include the current itinerary and cached report snapshot when available; device removal downloads a backup first.

### Maintenance and performance

- Indexed spatial queries, cached aggregates, incremental database writes and worker-based species clustering.
- ESLint/Vue correctness checks, Prettier, Knip, and CI checks; retired the old pages and unused dependencies.
- Validated major trip-library, import/export, editor, offline, permissions/sharing and recovery workflows using disposable Firebase emulators, plus dataset-scale editing benchmarks.

### Beta limitations

- Personal life/region lists and display preferences stay on the current device; personal lists do not yet synchronize across devices.
- Uncached eBird report data requires the report API. Cached map tiles do not guarantee complete offline map coverage.
- Offline conflicts preserve device recovery copies; resolving them requires manually reapplying desired edits. There is no automatic merge or hard single-editor lock.
- Undated planning, additional national basemap providers, source-dataset replacement and reusable datasets are not implemented.
- Physical-phone/Safari and peak raw-import memory testing remain limited. The repeatable editing benchmark stubs internet map tiles.

### Running this beta

Use Node 22.13+ or Node 24 LTS, then `npm ci` and `npm run dev`. Run `npm run check` for code quality and unit tests. The emulator/browser and performance commands are documented in [workspace development](docs/workspace-development.md).

For cloud autosave/sharing, configure the Firebase web environment and deploy the repository's Firestore/Storage rules to the intended Firebase project. Publishing this source prerelease does not deploy rules, migrate live cloud trips, or replace the public GitHub Pages app. Download backups before upgrading important trips.
