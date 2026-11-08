# v2.0.0 release checklist

Working checklist for the stable v2 release. An unchecked item needs work or an explicit scope decision; it does not imply that a feature is required for v2. Record decisions and evidence here as they are made. See [workspace development](workspace-development.md) for implementation details and historical measurements.

## Scope decisions

- [ ] Agree on the stable v2 feature set and identify any remaining gaps in the trip library, map, species view, reports, sharing and backups.
- [ ] Decide whether cloud synchronization of personal life/region lists and shared report snapshots are required for v2 or documented as limitations.
- [ ] Decide whether editor presence, dataset replacement, reusable datasets, expanded recovery retention, undated planning and additional national basemaps belong in v2 or a later release.
- [ ] Decide whether the single trip time zone is sufficient for trips crossing time zones and document the override and boundary limitations.
- [ ] Set acceptable large-import, mobile memory and responsiveness budgets, and decide how offline map coverage will be communicated.

## Integration and data safety

- [ ] Review and integrate the uncommitted changes on the v2 branch, including EBD-required trip creation, automatic time zones, route simplification and cloud rules.
- [ ] Reconcile the published-app URL changes on `main` and the uncommitted changes in the separate `codex/lowercase-hyphen-names` worktree with v2; verify routes, PWA scope, assets and shared links under the final deployment URL.
- [ ] Verify import, export and recovery of existing device trips and v1–v3 backups, including trips without EBD, personal flags, notes, routes and report connections.
- [ ] Verify migration of legacy cloud trips, permissions, visitor and editor links, revocation, offline edits, conflicts and recovery without losing data.
- [ ] Verify deployed Firebase rules and CORS against the intended production configuration and the final app origin; document any required deployment steps.
- [ ] Define and document the backup, recovery and rollback procedure for the release, including the behavior and limits of cloud plans and offline maps.

## Release validation

- [ ] Run `npm run check`, `npm run test:workspace`, and a regular `npm run build` on the release candidate; record results and resolve failures.
- [ ] Run the relevant workspace and large-import performance tests against the agreed budgets, including peak memory and a representative real archive where available.
- [ ] Test essential workflows on physical mobile devices, including Safari, and on supported desktop browsers; check offline use and installed PWA updates.
- [ ] Check end-to-end creation, editing, map and species calculations, report refresh, sharing, backup restoration and accessibility on the release candidate.
- [ ] Review build warnings, bundle size and browser compatibility data, and resolve or explicitly accept their impact.

## Ship

- [ ] Update the README, user guidance, changelog and known limitations to match the final behavior and deployment URL.
- [ ] Choose and validate any further beta or release-candidate versions; keep `v2.0.0-beta.1` as the existing historical tag.
- [ ] Review the final diff and complete CI on the release commit; integrate v2 into `main` with the URL changes preserved.
- [ ] Confirm production configuration and deployment sequence, publish v2.0.0, and verify the deployed app, PWA update, Firebase access and existing shared links.
- [ ] Monitor the release and document any follow-up issues and rollback actions.
