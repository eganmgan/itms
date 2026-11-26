# Coordinated release review — 2026-09-22

## Decision and scope

**Review and isolated rehearsal only; not deployment approval or a live readiness claim.**
Patch → Apps, Gatepass company snapshots, and custom password reset are present
in MAIN. Deploy the matching backend/schema and frontend as a coordinated
release, not a frontend-only update. The working tree includes many additional
pending changes: freeze and review the complete candidate rather than treating
the three UI changes as the entire backend release.

The initial local review performed no production database queries, migrations,
container operations, endpoint actions, password resets, publication, commits,
or pushes. Subsequent user-authorized read-only deployment preflight, fresh
backups, isolated migration rehearsal and temporary-file cleanup are recorded
below. No deployment or production data changes were performed.

## Local validation

- Full frontend: **34 files passed; 737 tests passed, 1 skipped**.
- Forced TypeScript build, oxlint, and Vite production build passed.
- Tests and Vite build used the Node APIs with `envDir: false`; no environment
  files were loaded by those invocations.
- Existing warnings: extensionless Vite configuration import and a PDF chunk
  above the bundler warning threshold. Neither failed the build.
- Backend full suite passed with Go 1.25.0:
  `go test ./... -count=1 -timeout=5m` (9 packages passed; 8 had no test files).
  The rerun used a clean environment (`env -i`), cached dependencies with
  `GOPROXY=off` and `GOSUMDB=off`, and an isolated temporary build cache.
  The existing build cache was not writable; no permissions were changed.
  No runtime environment files were loaded and no live smoke scripts were run.

Offline tests are not evidence of successful real PostgreSQL migration,
production Salt/provider compatibility, or authenticated live browser behavior.

## Authorized read-only preflight - 2026-09-22

**Checks completed; deployment remains gated.** Container inspection, read-only
SQL, archive-list validation and health requests were authorized. No containers
were created/restarted, migrations applied, backups restored, endpoint commands
sent, or frontend files published. No configuration secrets were printed.

- Backend and PostgreSQL are running and healthy. Backend remains
  `backend-backend:release-manual-entry-20260919`, image ID
  `sha256:e9dadb2c49014c84a94e7b5e53995cb9fd0ba0d199f481e2836dd8e25ef11130`.
  Backend health returned `status: ok` and `database: up`.
- The current private release override selects that same image. All 61
  configured backend environment values match the running container, including
  the private database environment file; only `PATH` is additional at runtime.
  This verifies the existing configuration, not a future release override.
- Served HTML still matches the September 21 release SHA-256:
  `15918fa4af93fc094539c6350e153d4c8d926b2e4a133e43162119d62d1211c0`.
  Direct loopback HTTP returned 302; authenticated browser behavior was not
  checked. The Apps tab has not been published.
- Production ledger contains 45 filenames through migration 042. All 45
  historical migration files match the running backend byte-for-byte; the only
  additional local migrations are 043-047. Queried new-schema indicators are
  absent and software name/version columns remain character varying.
- Migration 043 has zero duplicate unresolved `patch_inventory` groups.
  Snapshot counts: 2 users, 2 assets, 11 departments, zero Gatepasses, zero
  assets without an entity, and zero other transactions older than five minutes.
  These checks do not establish complete company/recipient/approver mappings or
  guarantee lock availability at deployment time.
- Existing September 22 backup `patch-apps-20260922-FbdjpB/postgres-itms.dump`
  under the private release directory has mode 0600 in a mode-0700 directory.
  `pg_restore --list` succeeded with 427 archive entries. This is archive-list
  validation, not a restore or migration rehearsal.
- Its frontend archive is readable (117 entries) but includes 6 installer
  entries. Do not restore it wholesale; preserve installers and create a fresh
  deployment backup excluding them. Current runtime-configuration backup
  completeness has not been established.
- The filesystem has approximately 4.3 GB available and is 93% used. Confirm
  space for build artifacts, fresh backups and an isolated restore before
  proceeding; no cleanup was performed.
- Salt URL, username/password and eauth settings are present; token is empty.
  Provider authentication, package approval and target compatibility have not
  been tested. No Salt endpoint operations were sent.
- Candidate remains unfrozen: 70 tracked changed paths and 151 untracked files
  relative to Git. These are not a diff against the live release. The safe
  insert-only startup-seeding correction remains present in current source.

The backup and isolated-rehearsal gates were subsequently completed below.
Remaining gates: freeze/review the complete release candidate and artifact
hashes; verify final build capacity and backup freshness at cutover; verify
Salt/provider and Gatepass mapping requirements; select the new release
image/configuration and obtain explicit cutover approval.

## Authorized backups, rehearsal and cleanup

- Fresh private backups are retained at
  `/home/itms/.local/state/itms/releases/apps-rehearsal-20260922-axji585b`.
  They contain the database dump, served frontend excluding installers, runtime
  configuration and inspection, resolved Compose configuration, baseline image
  identities and candidate checksums. Backup checksums were verified again after
  rehearsal; the directory is mode 0700 and all contained files are mode 0600.
- The fresh database dump was restored successfully into a temporary PostgreSQL
  container using the existing local image, no network, no published ports and
  memory-backed database storage. The application was not started.
- The repository migration runner applied 043-047, taking the isolated ledger
  from 45 to 50 entries. All 54 pre-existing business tables retained their data
  fingerprints. Five new tables were created. A second migration-runner pass
  left both data fingerprints and the migration ledger unchanged.
- Results are retained privately in `rehearsal-result.json`. This validates
  migration behavior on that backup, not production lock timing, startup seed
  execution, live provider compatibility or authenticated user workflows.
- The temporary rehearsal container was removed. Follow-up cleanup removed the
  identified 146 MB temporary build directory and empty runner source directory.
  No existing source changes, recovery backups, installer files or Docker images
  were deleted. Approximately 4.6 GB is now free (92% filesystem usage).
- Post-rehearsal verification at approximately 11:03 UTC confirmed unchanged
  production container IDs, images and start times, and unchanged served HTML
  compared with the fresh backup. Both containers remain healthy; API health
  reports the database up. Production still has 45 migrations through 042, with
  aggregate counts of 2 users, 2 assets and 11 departments.

The Apps tab is still not live. No production migration, backend restart or
frontend publication was performed; coordinated cutover remains separately
gated and requires explicit authorization.

## Migration and compatibility findings

Required files: migrations **043–047**, in addition to all previously applied
migrations. Confirm the actual production migration ledger before deployment;
do not infer it from documentation or a numeric migration count.

- **043** widens software name/version columns and creates telemetry storage.
  It also adds a unique partial index on unresolved `patch_inventory` alerts.
  Existing duplicate `(asset_id, source)` rows satisfying that predicate would
  prevent index creation. Check for duplicates in an authorized preflight;
  do not silently delete or resolve real alerts to make the migration pass.
  Column alterations/index creation can acquire locks; additive does not mean
  zero operational risk.
- **044** creates catalog/install-request tables; **045** creates recorded
  service storage; **046** creates durable management-request storage.
  044/046 use plain `CREATE TABLE`, not universally rerunnable SQL. Use the
  migration runner and ledger, not manual re-execution of these files.
- **047** adds nullable Gatepass snapshots without historical backfill.
  Existing records stay readable but official PDF export is blocked for
  unverified legacy snapshots. Confirm this product behavior before rollout.
- The runner sorts filenames and commits **one transaction per migration**.
  If a later migration fails, earlier successful migrations remain committed.
  It does not compare historical file hashes or serialize simultaneous runner
  instances. Compare historical migrations separately and use one migrator.
- **Gatepass creation is not backward compatible with old free-text payloads.**
  The new backend requires scoped canonical IDs and company resolution. Plan
  the cutover and refresh stale browser tabs; do not leave the old frontend
  serving as the final state after backend deployment.
- The custom-password form uses the existing reset API. It does not add session
  revocation or force a password change on next login.

## Required authorized preflight

These are deployment gates. The preflight above records partial completion;
time-sensitive checks must be repeated against the frozen candidate at cutover:

1. Confirm the full candidate scope and source/artifact hashes. Review all
   pending backend changes and verify the safe startup-seeding fix is retained.
2. Inspect running image/configuration and migration ledger without printing
   secrets. Compare the effective intended backend environment privately with
   the running environment. The backend Compose definition includes a third
   private database environment file via `ITMS_DATABASE_ENV_FILE`; the two
   repository environment files alone are **not** sufficient.
3. Verify the actual release image override; a generic Compose recreation can
   select the wrong image/configuration. Preserve PostgreSQL unchanged and
   avoid bringing up or recreating the whole stack.
4. Make durable restricted backups of the database, served frontend excluding
   installers, runtime configuration, and current image identity. Validate the
   database archive. Never place private backups in Git or a build context.
5. Check migration-043 index prerequisites and schema/ledger consistency.
   Rehearse migrations against a separately approved isolated restore and
   choose an appropriate maintenance window for lock-taking changes.
6. Verify Salt configuration/provider availability separately. Review approved
   packages and OS compatibility; passing mocked tests does not establish
   production install/remove/service behavior. Deploying the UI does not
   distribute updated collectors or guarantee fresh recorded inventory.
7. Confirm valid company/branch/recipient/approver mappings and acceptance of
   legacy Gatepass PDF restrictions. Unmapped external companies are not
   automatically inferred or supported.

## Cutover, verification, and recovery

- Following explicit deployment approval and successful preflight, update only
  the backend with the selected release configuration. Verify migration
  results, startup, health, and retained business data before publishing the
  matching frontend. On failure stop the cutover and inspect the ledger.
- Publish hashed frontend assets before atomically replacing HTML; retain old
  hashed assets and preserve the installer directory. Record actual deployed
  identities/hashes rather than assuming the local build is live.
- Verify sign-in, role/scoping boundaries, `/patch/apps` and its legacy alias,
  Gatepass canonical company selection and historical behavior, and the custom
  password form. Real Gatepass creation/password resets and endpoint actions
  need deliberate approved test records/accounts/targets; do not mutate real
  data just to smoke-test the release.
- Start Apps verification with permissions/catalog/inventory/history. Live
  service discovery performs a read-only Salt call and requires an appropriate
  target. Installation/removal/service actions are separate explicit tests.
  Unknown HTTP 202 outcomes must be queried by their existing request UUID,
  never automatically retried under a new UUID.
- Rollback requires a reviewed compatible backend/frontend pair and preserved
  runtime configuration. Never restore a binary with destructive startup seeds.
  Retain durable action reservations, including unknown outcomes: erasing them
  can defeat at-most-once protection. Do not automatically restore an old DB
  backup, undo additive schema, or discard post-release business records.

## Do not use the umbrella readiness script as an offline check

`scripts/check-itms-release-readiness.sh` invokes authenticated API smoke tests,
installer/chat checks, environment/secret checks, and live integration reads.
The API smoke script creates/deletes inventory records and can execute a remote
terminal command. Omitting `--with-live-integrations` does **not** make the
umbrella script offline or read-only. It was intentionally not executed here.

## References

- [Local feature changes](gatepass-apps-password-2026-09-22.md)
- [Apps & Services contract](../backend/APPS_SERVICES_API.md)
- [Gatepass records contract](../backend/GATEPASS_RECORDS.md)
- [Migration runner](../backend/internal/platform/database/migrate.go)
- [Previous coordinated release safeguards](manual-entry-live-release-2026-09-19.md)