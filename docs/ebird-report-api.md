# Report 468402: API verification and stop aggregation

Verified on 18 October 2026 through the same public proxy already used by CreateTrip.vue. No account credentials or new API key were required for this report. Its checklist response returned HTTP 200 and `access-control-allow-origin: *` for the localhost origin. These are internal eBird endpoints, not a guaranteed stable public API contract.

| Endpoint suffix under `https://tripreport.raphaelnussbaumer.com/tripreport-internal/v1/` | Confirmed result                                                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `taxon-list/468402`                                                                      | 276 taxa; 238 entries with category `species`; global individual/checklist totals                                                          |
| `locations/468402`                                                                       | Location IDs, coordinates, names, hotspot flag                                                                                             |
| `checklists/468402`                                                                      | 353 unique checklist IDs at 294 unique location IDs; 6–25 February 2026; checklist dates, declared species totals and location coordinates |
| `taxon-detail/468402/<speciesCode>`                                                      | Per-taxon checklist IDs, observation dates and `howMany`; join to checklist metadata using `subId`                                         |

The existing [Chrome extension](https://github.com/Zoziologie/Zoziologie-Chrome-Extension/blob/main/js/eBird-tripreport.js) also uses the checklist and taxon-detail endpoints. The current planner calls only taxon-list, so this is a confirmed extension to its existing integration, rather than a speculative new service.

## Small data sub-operation

1. Fetch checklist metadata once per report refresh; deduplicate by `subId` and retain coordinates and date.
2. Fetch/cache taxon-detail once per taxon, joining observations to checklist IDs. Avoid repeating this work per stop or on every click. Prototype download concurrency is four requests, with a reusable disk cache.
3. For a stop's current area, select all report checklists inside that area and before the snapshot cutoff. The initial circular area uses the existing radius; a later polygon would replace only the containment predicate.
4. Return unique checklist IDs, a union of taxa, per-taxon reporting-checklist counts and summed known individuals with an unknown-count flag. Counts are observations summed across checklists, not unique individual birds.
5. Use the same return object for stop details, Recorded species, and map selection. Full-trip aggregation deduplicates across all report checklists; never sum stop lists because areas can overlap.

Matching is spatial over all report dates by default, as requested. It does not require the actual checklist date to equal the planned visit date. Repeated planned visits to one area can therefore show the same recorded list. A future date-constrained comparison should be an explicit alternative. Temporal marker fill is independent of this evidence: past does not mean visited, and a checklist can precede the planned visit.

## Verified data coverage

The provided archive has 63 stops across 6–26 February (21 days), usually 2–5 stops a day, with some genuine 1/6-stop days and no planned stop on 23 February. Preserve these real variations rather than inventing extra stops. Its cached routes and historical EBD dataset (5,305 locations) are reused.

Across all report dates, 55 planned birding stops contain at least one report checklist; 224 distinct checklist IDs lie in at least one planned birding area, and 129 lie outside all such areas. Outside checklists remain visible on the report map and included in full-trip results. These counts describe spatial coverage, not visit completion.

A separate Haversine calculation verified Al Saadah Park: two checklists in its area through 16 February and 27 distinct taxa in their union. The browser aggregation gives the same result.

Species details were returned for 329 of 353 checklist IDs. Twenty-four metadata records have no joined taxon observations in the retrieved detail responses. The reason is not established; do not assume those checklists had zero species. The joined detail responses identify 236 species-category taxa, versus 238 in the global taxon-list response. Use the global totals for the full after-trip view; stop/partial-date unions must signal incomplete detail coverage. A during-trip species total is a lower bound when metadata checklists lack details.

This data processing is worth validating at prototype stage because it determines what the UX can honestly show. Production caching, refresh orchestration, access errors, taxonomy reconciliation, sharing policy and regression tests belong in implementation. The prototype is backed by a cached real snapshot; it does not automatically poll eBird or write to the user's account.

## Reproduce the fixture

Use `scripts/prepare_oman_prototype.py --archive <path-to-ebird-trip-Oman.json> --cache <local-cache-directory>`. It fetches the public report and builds `docs/prototypes/oman-data.json`, excluding observer identifiers and media. Round 6 also keeps the archive’s EBD observer comments for the existing copy/download flow, and checklist effort measurements for medians. Three malformed comment strings contained EBD record spillover after a newline and `URN:CornellLabOfOrnithology:`; the fixture retains only their comment prefix. The app's working database is untouched. Routes are simplified for rendering while retaining the archive's saved distance/time totals.
