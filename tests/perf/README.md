The old `perf:standard` and `perf:large-flow` page-navigation scripts were retired with the old interface. Active browser correctness is in `tests/workspace/flow.mjs`; active editing performance is in `tests/perf/workspace-flow.mjs`. The raw EBD streaming benchmark and fixture generator remain available. Older measurements and commands below document the earlier interface and are historical.

# Testing

```bash
npm test              # correctness: EBD parsing and the comment corpus
npm run test:workspace # trip library, import/export, editor, offline and cloud correctness
npm run perf:workspace # active editor performance with large datasets
```

Everything below is about the second question: does it still work when the
dataset is real?

## The EBD is an unquoted TSV. Do not let a parser think otherwise.

eBird strips tabs and newlines out of text fields, so **every row splits cleanly
on tabs** - 2,764,777 of 2,764,777 rows in `ebd_MX-ROO_relJul-2026`, no
exceptions. Fields are never quoted, and a `"` inside a comment is literal data:

> `"Slewing" in erratic soaring in wind with wings in slight upswept dihedral.`

A CSV parser with default settings reads that leading quote as the start of a
quoted field and swallows everything up to the next `"`, anywhere later in the
file. 58 species comments and 20 checklist comments in that one export open with
a quote, and the damage was:

|                          | with default quoting      | unquoted (correct) |
| ------------------------ | ------------------------- | ------------------ |
| rows ingested            | 2,567,955 (**7.1% lost**) | 2,764,777          |
| stored comment text      | 62 MB                     | 2.1 MB             |
| longest single "comment" | 14.4 MB                   | 2,735 chars        |

`EBD_PARSE_OPTIONS` disables `quoteChar`/`escapeChar` for this reason. The
failure is silent - no parse error, no warning, just missing observations - so
`tests/unit/ebd-comments.test.mjs` guards it, and the generated fixture
deliberately over-represents quote-opening comments so even a tiny dev fixture
exercises the path.

## How big is a real EBD?

Measured from `ebd_MX-ROO_relJul-2026`, which is the working definition of a **1x
reference export**. A high-end single trip is **2-4x** this.

|                              | value     |
| ---------------------------- | --------- |
| zip on disk                  | 104 MB    |
| unpacked `.txt`              | 1.1 GB    |
| observation rows             | 2,764,777 |
| checklists                   | 142,206   |
| complete checklists (stored) | 105,244   |
| distinct locations           | 33,370    |
| distinct species             | 506       |

Shape statistics, for reasoning about a specific code path:

- 74% of checklists are complete (only those contribute species records)
- species per complete checklist: median 12, mean 16.7, p90 36, max 171
- checklists per location: median 1, mean 4.3, max 1669
- duration minutes: p10 10, median 56, p90 194
- hotspots are 1.5% of localities but carry 47% of the rows
- 46.7% of rows belong to shared group checklists, so a checklist averages 19.4
  rows against the 16.7 species it records
- 3.5% of observations carry a species comment: median 17 chars, mean 36, max 2,735
- 10.5% of checklists carry a checklist comment: median 50 chars, mean 85

### Visits

Visit records are small in number but not in bytes. A real 5-day trip export
(18 visits, 17 driving routes) carries 7,655 route coordinate pairs - about
450 per leg, up to 1003 - plus a `statsSpeciesCounts` object per visit with one
key per species in range. Assume tens of visits, not thousands, but do not treat
a visit as a cheap object to deep-clone or deep-watch.

## How a trip is stored

Three tables, because the pages have three very different appetites:

| table        | key                   | 1x size                  | read when                                    |
| ------------ | --------------------- | ------------------------ | -------------------------------------------- |
| `ebd`        | `tripId`              | 18.6 MB                  | every page, always                           |
| `checklists` | `[tripId+localityId]` | 105.3 MB (33,370 rows)   | a map popup or KML export needs one location |
| `comments`   | `tripId`              | 11.3 MB (35,149 entries) | someone exports comments                     |

The split exists because checklists were ~99% of the old single record while only
two features read them, and because a comment export keyed by species would
otherwise have to read most of the `checklists` table - a widespread species
spans thousands of localities.

Two details worth knowing before touching this:

- Checklist **effort values** stay on the location (`checklist_durations` and
  `checklist_distances_km`), because
  the Build Trip visit summary needs a median across every location in range and
  that cannot be recovered from per-location medians. They cost well under 1 MB.
- **There are no migrations, on purpose.** Only the current schema is declared in
  `db.js`; superseded ones are not kept. A trip keeps whatever shape it was
  written with, so an older trip may carry `location.checklist` inline or have no
  comment corpus at all - re-import its EBD to bring it up to date. The schema
  version is the minor version in `package.json` (schema 3 ships as 0.3.x); bump
  them together.

Peak heap when opening each page, measured with `perf:large-flow` on a persistent
profile:

|                   | Species List | Species Map | Build Trip |
| ----------------- | ------------ | ----------- | ---------- |
| `ebd_MX-ROO` (1x) | 84 MB        | 95 MB       | 155 MB     |
| scale-2 fixture   | 298 MB       | 337 MB      | 514 MB     |

For reference, before checklists were split out of the `ebd` record those same
pages cost 536 / 546 / 832 MB at 1x and 929 / 964 / 1449 MB at scale 2.

## Where the work happens, and what has to be cheap

Importing an EBD is a **desktop** activity - it peaks around 0.8-1.5 GB of heap
and is expected to. Everything _after_ the import has to survive a **phone**
(roughly 300-400 MB before the OS kills the tab), so post-import heap is the
number that matters most.

Comment export is deliberately the exception: it is a rare, explicit action, so
it reads the whole corpus and formats it without any indexing. At 1x that is a
transient ~11 MB; at 4x, ~45 MB.

## Measuring in a browser: use a persistent profile

A trip is written as one `db.ebd.put()` value, and how large a single IndexedDB
value may be **depends on the browser context**:

| context                                       | 109 MB value | 146 MB value                      |
| --------------------------------------------- | ------------ | --------------------------------- |
| Playwright `browser.newContext()` (ephemeral) | 1.3 s        | **rejected** at 133,169,152 bytes |
| `launchPersistentContext` (real profile)      | 1.3 s        | 2.1 s                             |

An ephemeral context reports a healthy quota (7 GB) and then refuses the write
with "The serialized keys and/or value are too large". A real browser profile
accepts it. **Always drive performance tests with `launchPersistentContext`**, or
you will measure a ceiling that does not exist for users. `large-flow.mjs` does
this.

## Test datasets

### Small - for development

`tests/perf/standard-flow.mjs` builds its own tiny fixture (1,440 rows, 12
locations) and asserts correctness plus fixed overhead. Fast, no setup:

```bash
npm run perf:standard
```

This is the one to run while iterating. It will **not** catch scaling problems:
at 800 locations a change that made dragging 4x faster measured as no change at
all.

### Large - for performance work

Generate a fixture calibrated to the statistics above. Scale 1 is about
`ebd_MX-ROO`; use 2-4 for the high end.

```bash
npm run perf:fixture -- --scale 2 --out /tmp/ebd-2x.txt
zip -j -q /tmp/ebd-2x.zip /tmp/ebd-2x.txt   # the app's real input path
npm run perf:large-flow -- /tmp/ebd-2x.zip
```

Fixture output at each scale (seed 42), against the real export it models:

|                   | rows   | checklists | locations | `.txt` | zip    | `ebd`   | `checklists` | `comments` |
| ----------------- | ------ | ---------- | --------- | ------ | ------ | ------- | ------------ | ---------- |
| real `ebd_MX-ROO` | 2.76M  | 142,206    | 33,370    | 1.1 GB | 104 MB | 18.6 MB | 105.3 MB     | 11.3 MB    |
| scale 0.02        | 45,040 | 2,708      | 621       | 16 MB  | 2 MB   | 0.5 MB  | 2.0 MB       | 0.3 MB     |
| scale 1           | 2.40M  | 144,938    | 33,370    | 855 MB | 108 MB | 27.7 MB | 108.3 MB     | 15.2 MB    |
| scale 2           | 4.82M  | 290,800    | 66,740    | 1.7 GB | 217 MB | 55.2 MB | 216.8 MB     | 30.5 MB    |

Scale 1 matches the real export closely on the table that dominates memory
(`checklists`, within 3%) and on location count exactly. Known simplifications:

- **No group checklists.** The generator emits one row per species, so it
  produces ~13% fewer rows than a real export with the same checklist count, and
  never exercises the group-merge path in `addEbdRow`.
- **The `ebd` record runs ~49% large** because species are drawn independently
  per checklist, so a location accumulates more distinct species than a real one.
- **Comments are spread too evenly** (65k comment-bearing checklists against a
  real 35k): real observers either comment often or never.

Run these with a persistent profile (see above).

### Parser only

`perf:large-import` runs the EBD reader against any real export without a
browser, reporting time and heap per 10% of the file:

```bash
npm run perf:large-import -- ~/Downloads/ebd_MX-ROO_relJul-2026.zip
```

## Testing against a real export

If you have a real EBD zip it is always the better test - the generated fixture
approximates the distributions, but real data has quirks (comments opening with a
quote, merged group checklists, subspecies rollups, a 1900-2026 date range) that
a generator will not reproduce. Do not build subsets with line-based tools:
sample whole checklists by `SAMPLING EVENT IDENTIFIER` with a real CSV reader
configured for an unquoted TSV, so `ALL SPECIES REPORTED` stays meaningful.

## Working workspace (v0.5)

The historical `perf:standard` and `perf:large-flow` commands above exercise the legacy pages and importer. They do not cover the reviewed prototype port. Use `npm run perf:workspace` for the current `/workspace` interface.

```bash
npm run perf:workspace
PERF_SCALES=1 npm run perf:workspace
PERF_ARCHIVE=/absolute/path/to/trip.json npm run perf:workspace
```

The new test builds production assets and uses a disposable persistent browser profile, with no sign-in or live cloud writes. It seeds processed EBD data at 33,370, 66,740, and 133,480 locations, 506 taxa, 63 stops over 21 days, 450 route coordinates per leg, and 353 report checklists. Each synthetic location has 50 species counts and effort samples; this stresses workspace rendering and recomputation, rather than repeating the raw TSV import benchmark. The optional archive mode runs the same interactions against a private local JSON export without modifying the file or the user's browser database.

It measures opening, five note edits, stop selection, area resizing, Map/Species switching, sorting, full-trip selection, and post-GC JavaScript heap. Interaction timing includes the handler and two animation frames. Default budgets are 10 seconds to open, 250 ms per interaction, and 400 MB post-import heap. `PERF_INTERACTION_MS` adjusts the interaction budget for slower machines; CI runs the 1x case with 500 ms. Reports are saved to `output/playwright/workspace-performance.json`; `PERF_RESULT` can change the output path. Install Chromium with `npx playwright install chromium`, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing compatible executable.

Mapbox rendering and source processing run normally, but the benchmark supplies an empty local base style to remove internet/tile variability. These are desktop Chromium measurements, not a guarantee of phone memory, frame rate, tile-download speed, or raw-import performance. Use the real archive and a phone for the next device-specific pass.

The workspace now indexes immutable EBD locations by latitude, caches each stop's spatial membership, reuses report aggregates/date formatters/map sources, and computes species tables only while visible. Notes do not redraw maps or tables, and local saves update only changed stops. Geometry/type changes invalidate spatial and species results; duration/targets/personal-list changes invalidate planning results. Undo restores and recomputes those results. Species-map clustering runs in a disposable Web Worker and is terminated when the workspace closes.
