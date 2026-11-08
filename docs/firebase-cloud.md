# Firebase cloud storage

The app provides persistent Google sign-in and app-managed cloud trips. Each trip owns an EBD dataset and itinerary; there is no separate dataset library. New trips require imported EBD data, while older trips missing data require it before the planner opens. Browser data is the working copy. Signed-in creation enables cloud autosave by default: the source dataset uploads once, and itinerary edits sync as a compact workspace plan, including after reconnecting from offline use. My trips combines device and cloud entries into one library. Sharing provides separate viewing and editing links, with access controlled by the owner. Creating from eBird data and importing a saved trip backup are separate ways to add a trip.

## Project and configuration

Firebase project: `ebird-trip-planner`. Authentication uses Google only. Firestore is Standard, Native mode, `(default)` database. Storage uses `ebird-trip-planner.firebasestorage.app` in `US-EAST1`. Production security rules are in the repository; do not switch either service into test mode.

Set these public Firebase web settings in `.env.local`, and as GitHub Actions repository variables for deployment:

```
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_APP_ID=
```

No service-account key belongs in the frontend. Authentication remembers the account in this browser and refreshes the Firebase session. Google Drive integration has been removed. Existing local trips and files already saved in Drive are not migrated or deleted.

Authorized login domains include `localhost`, `127.0.0.1`, the Firebase domains and `zoziologie.github.io`. Storage CORS origins are in `firebase-cors.json`. Apply them with:

```
gcloud storage buckets update gs://ebird-trip-planner.firebasestorage.app --cors-file=firebase-cors.json
```

Browser Storage downloads require the exact origin, including the port, in that configuration. The allowed development origins include both localhost spellings on ports 5173 and 5174, preview on 4173, and both production domains. A missing origin can appear as `storage/retry-limit-exceeded` while the browser reports `MissingAllowOriginHeader`. On 19 October 2026, port 5174 and the custom production domain were added to the live bucket; downloading and opening the existing Kenya trip was verified in the signed-in browser. Emulator tests alone do not validate live CORS or Google sign-in.

The paired workspace Firestore and Storage rules were also deployed and verified active on 19 October 2026. They allow automatic time zones in compact plans, restrict plan writes to authorized owners/editors, and close anonymous source-archive downloads once a trip is migrated. Existing cloud trips were not migrated or overwritten during this rollout. Uploads and workspace autosave were validated against emulators; the signed-in live-browser check covered the existing trip download.

On 8 November 2026 the default allowance was raised from one to three cloud trips (Firestore ruleset `a376f8b6-ac2b-402d-b06d-0c2f8f2c25d4`; previous `e4f851af-7dd7-4725-b20a-e1f9abb11efe`). Capacity requests now ask for 4–10 trips.

Storage rules inspect Firestore access documents. The Firebase Storage service agent requires the `roles/firebaserules.firestoreServiceAgent` role in this project.

## Free allowance and capacity requests

Any verified Google account can create three cloud trips without an invitation. Each compressed archive is limited to 50 MiB. Archives include life and region lists and all exported trip data. Shared trips do not consume an editor's own allowance. There is no global user limit.

The **Request more capacity** form writes `capacityRequests/<Firebase UID>` with email, requested total trip slots (4–10), reason and pending status. Requests do not change permissions or capacity. Only administrators can approve them.

To approve in Firebase console → Firestore:

1. Open a document in `capacityRequests` and copy its document ID (the user's Firebase UID).
2. Create or update `cloudAccounts/<same UID>` with integer `tripSlots`, for example `5` for five 50 MiB trips (250 MiB maximum active archives).
3. Set the request's `status` to `approved` or `declined`. Changing status alone does not change capacity.

The client cannot edit its allowance. Default capacity is three trips if no `cloudAccounts` document exists. Lowering an allowance prevents creation in extra slots but preserves access to existing trips; it does not delete anything or ban the account. This is per-trip capacity, not an aggregate byte allowance. A total-size model would need a different reservation/accounting scheme.

## Retention and activity

The app explains that free cloud storage has no guarantee of long-term retention and that trips inactive for more than six months may be deleted. Keep exported backups. Opening a trip while signed in as its owner or editor, or saving it, records `lastActiveAt`. Public anonymous views and merely listing cloud trips do not renew activity. There is no automatic six-month deletion job: the weekly report identifies candidates for an administrator to review.

For older archive-based trips, new revisions upload separately and are published only after completion. A transaction checks the previous revision to stop a stale browser from replacing someone else's save. Old archives are removed after a successful save. Interrupted first uploads can retry the same empty slot. Workspace trips instead retain one source revision and sync plan edits separately, preserving recovery copies for conflicting device edits. See [workspace development](workspace-development.md) for the current sync behavior.

Viewing links require the owner to enable public viewing. Recipients do not need accounts. Access is checked through security rules rather than permanent download-token links, so disabling public viewing blocks later downloads; already downloaded copies cannot be recalled. The editor-email list is stored separately from public trip metadata.

## Costs and operational limits

Blaze billing is required for Storage. The free allowance is usage-based, not a guarantee of a zero bill. At 100 users, one 50 MiB file each would occupy about 4.9 GiB before temporary uploads and retained deleted versions. The bucket currently has Google's default seven-day soft-delete retention: frequent saves can retain additional billable data. Monitor actual Storage/Firestore usage and billing before inviting more users. There is no automatic spend cutoff in this implementation.

A browser crash can leave an upload reservation for ten minutes and a staging object. A subsequent save clears the previous staging object. There is no scheduled orphan cleanup yet. Owners can use **Cloud actions → Delete cloud trip** to stop sharing, remove the cloud archive and free its slot while keeping the browser copy. Reload first if the cloud revision changed. Deleted archives follow the bucket’s soft-delete retention.

## Validation

```
npm test
npm run test:cloud:rules
npm run build
```

The security tests use a demo project with Firestore and Storage emulators. Java 17 is supported by the pinned Firebase CLI 14; upgrade the CLI and Java together later.

For browser testing against emulators, run Auth, Firestore and Storage and start Vite with `VITE_FIREBASE_EMULATORS=true`. Never set that variable for a production build.

Manual checks: Google login; reload remembers login; save and reload a trip; life/region lists survive; edits update the same file; a stale save is rejected; anonymous viewing works only while public viewing is enabled; an invited Google account saves back to the same trip; uninvited accounts cannot edit.

## Usage reports

Run `python3 scripts/cloud_usage_report.py` using your existing administrator `gcloud` login. The script is read-only and reports owners with saved trips, published/public trips, published archive bytes, all live bucket bytes, custom allowances, pending capacity requests and trips inactive for more than six months. It never approves requests or deletes data. It excludes retained soft-deleted objects, billing totals and download traffic; check Google Cloud Billing/Storage monitoring for those.

A Codex heartbeat in this chat is scheduled every Monday at 09:00 Europe/Paris to run the report. This depends on the local Codex environment and administrator login being available; it is not a server-side Firebase job or an email service. Pause or change it in Codex automations.
