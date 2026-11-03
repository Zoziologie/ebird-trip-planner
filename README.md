# eBird Trip Planner

**v2.0.0-beta.2** is a prerelease of the new trip-centered experience. See [release notes](CHANGELOG.md) for changes, limits and setup. The previous public release remains v0.4.0 until this beta is promoted.

Plan birding trips from the eBird Basic Dataset (EBD) with an offline-friendly, browser-first workflow. The app processes EBD files locally, stores results in IndexedDB, and gives you a trip builder, a species list with detection rates, and a species map with reporting-rate heat clusters.

## Main flow

1. **My trips** is the landing page. Load `.zip`/`.txt` eBird data to create a trip, import a backup, or open a cloud trip. Each trip contains its own EBD dataset and itinerary; creating a trip requires data with at least one location. Older trips without EBD ask for data before opening the planner and keep their existing stops and notes.
2. In a trip, switch between **Map** and **Species** while keeping the same itinerary selection. Edit stops inline, resize their areas, shift groups of stops, and undo changes.
3. **Trip settings** groups metadata, backups, map/display preferences, personal life/region lists and eBird report connection/refresh. Sharing remains in the toolbar.
4. Edits save automatically on the device. Signed-in creation enables cloud autosave by default; offline edits sync on reconnection, with recovery copies for conflicting edits.
5. Return to **My trips** to manage other trips. Backup imports create separate trips and preserve existing ones.

## Key features

- Local streaming EBD parsing with region/date filters and progress feedback.
- One itinerary/map/species interface for desktop editing and mobile use, with a visitor view.
- Historical reporting rates, expected species, personal life/region targets and species CSV export.
- Separate eBird hotspot/personal-location overlays, reporting-rate clusters, report-checklist locations and Map/Satellite basemaps.
- Stop notes, targets, report results and observer comments, with customizable visibility.
- Offline PWA persistence, cloud autosave, friend sharing, co-traveler editing and conflict recovery.
- Existing local trips and v1–v3 JSON/compressed archives remain readable. The old separate planning pages have been retired.

See [workspace development and validation](docs/workspace-development.md) for data limits, test commands and migration details, and the [v2 release checklist](docs/v2-release-checklist.md) for remaining decisions and validation. Undated planning and additional national map providers are not implemented.

## Tech stack

<table width="100%">
  <thead>
    <tr>
      <th align="center">
        Vue<br/>
        <sub>UI framework</sub>
      </th>
      <th align="center">
        Vite<br/>
        <sub>Build and dev tooling</sub>
      </th>
      <th align="center">
        Bootstrap<br/>
        <sub>UI components and styling</sub>
      </th>
      <th align="center">
        Dexie<br/>
        <sub>IndexedDB storage</sub>
      </th>
      <th align="center">
        Mapbox GL JS<br/>
        <sub>Interactive maps</sub>
      </th>
      <th align="center">
        Turf.js<br/>
        <sub>Spatial tools</sub>
      </th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center">
        <a href="https://vuejs.org/">
          <img src="https://raw.githubusercontent.com/devicons/devicon/master/icons/vuejs/vuejs-original.svg" height="40"/>
        </a>
      </td>
      <td align="center">
        <a href="https://vite.dev/">
          <img src="https://raw.githubusercontent.com/devicons/devicon/master/icons/vitejs/vitejs-original.svg" height="40"/>
        </a>
      </td>
      <td align="center">
        <a href="https://getbootstrap.com/">
          <img src="https://raw.githubusercontent.com/devicons/devicon/master/icons/bootstrap/bootstrap-original.svg" height="40"/>
        </a>
      </td>
      <td align="center">
        <a href="https://dexie.org/">
          <img src="https://dexie.org/_next/image?q=75&url=%2Fassets%2Fimages%2Fdexie-logo.png&w=256" height="36"/>
        </a>
      </td>
      <td align="center">
        <a href="https://docs.mapbox.com/mapbox-gl-js/guides/">
          <img src="https://upload.wikimedia.org/wikipedia/commons/1/1f/Mapbox_logo_2019.svg" height="40"/>
        </a>
      </td>
      <td align="center">
        <a href="https://turfjs.org/docs/next/getting-started">
          <img src="https://raw.githubusercontent.com/Turfjs/turf/9a1d5e8d99564d4080f1e2bf1517ed41d18012fa/logo.png" height="36"/>
        </a>
      </td>
    </tr>
  </tbody>
</table>

Additional tools: [Vue Router](https://router.vuejs.org/), [PapaParse](https://www.papaparse.com/), [JSZip](https://stuk.github.io/jszip/), [Bootstrap Icons](https://github.com/twbs/icons), [Vite PWA](https://github.com/vite-pwa/vite-plugin-pwa).

## Firebase cloud storage

Persistent Google sign-in, automatic plan sync, and visitor/editor links are available when Firebase web settings and workspace access rules are configured. The source dataset uploads once; itinerary edits update a compact shared plan. Older cloud archives can be opened and explicitly upgraded by their owner. Any Google account can save one compressed cloud trip up to 50 MiB, and request additional capacity for administrator approval. Free storage has no long-term retention guarantee; trips inactive for over six months may be deleted. Setup, access rules, billing caveats and testing are described in [docs/firebase-cloud.md](docs/firebase-cloud.md).

## Maintenance checks

Use Node 22.13+ (Node 24 LTS is also suitable). `npm run check` runs ESLint, Prettier checks, Knip's unused-code/dependency audit, and the small unit suite. `npm run lint:fix` applies supported lint fixes; `npm run format` formats source and documentation without wrapping Markdown paragraphs. Generated assets, the historical design prototypes and build output are excluded from formatting.

Linting focuses on JavaScript/Vue correctness. Formatting belongs to Prettier; Knip detects leftover files, exports and dependencies. Its explicit entry points include the Mapbox clustering worker and test harness, which run outside the normal application import chain. These checks run in CI before the existing major workflow, Firebase emulator, build and performance checks.

Keep testing focused on user-visible failures: trip creation/import/export, saving and offline recovery, permissions/sharing, stop edits and species calculations. `npm run test:workspace` exercises those flows with disposable local Firebase emulators. `PERF_SCALES=1 npm run perf:workspace` checks the 33,370-location/63-stop case; the default runs larger scales too. Map tiles are stubbed for repeatable application timing, so these results do not replace real-phone testing. Avoid adding tests for every helper or formatting change.
