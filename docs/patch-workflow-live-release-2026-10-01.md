# Patch Workflow Release - 2026-10-01

## Status

User-authorized full application deployment completed. Backend is healthy and
frontend files are published. No endpoint patch commands or reboots were run.
PostgreSQL was not restarted.

## Changes

- Published `scripts/salt/patch/baseline.sls` to `/srv/salt/patch/baseline.sls`.
  Verified the master's roots configuration and compiled the published state
  with isolated local Salt configuration using `state.show_sls`, not `state.apply`.
- Baseline supports Debian/Ubuntu, refreshes metadata and applies conservative
  upgrades using `pkg.uptodate` with `dist_upgrade: false`. It does not reboot.
  Unsupported systems fail without changes; held/dependency-transition packages
  may remain pending.
- Patch rejects apt commands in diagnostic mode locally and offers an explicit
  update-state action, preserving scope and requiring review/confirmation.
- Department execution uses asset department then assigned-user department,
  matching the device listing. PostgreSQL array encoding is explicit; incomplete
  target reads are rejected before execution.
- Hostname results show recorded package/version changes and failures. Missing
  SSH patch status displays Unknown rather than crashing.
- Includes the pending frontend/backend working-tree changes authorized for this
  full release, including chat assignment/presence and responsive table updates.
- Docker build excludes all `.env.*` files. Admin route tests use existing test
  mode; production command and rate-limit policies were not weakened.

## Validation

- Full frontend: 862 passed, 2 skipped; TypeScript and full Oxlint passed.
- Full backend: `go test ./... -count=1` passed in an isolated container with
  frontend template fixtures mounted. Dedicated rate-limit tests also passed.
- Candidate image built and started against a restored production database in
  a network-isolated ephemeral container with external integrations disabled.
- Migration 053 applied in rehearsal and production. Core counts were unchanged:
  3 users, 3 assets, 11 departments, 7 entities.
- Live health returned 200 with database up. Signed-out auth/me, patch/devices,
  departments and settings/chat returned 401.
- Live login, patch, devices and settings/chat HTML matched the build. All 36
  generated assets matched live responses byte-for-byte.
- Preview tests verified target retention, blocked apt submission and explicit
  confirmation with zero write requests. Production browser access failed with
  connection refused through the remote workspace; authenticated live workflows
  and actual endpoint upgrades were not verified.
- Rehearsal containers and the ephemeral database copy were removed.

## Release And Rollback

- Release directory: `/home/itms/.local/state/itms/releases/patch-workflow-20261001-r45IFV`
- Backend image: `backend-backend:release-patch-workflow-20261001`
- Previous image: `backend-backend:rollback-patch-workflow-20261001`
- Frontend root: `/var/www/itms`
- HTML SHA-256: `10d3cda7e457a0772718f79b1f5726f4a4fcfab887fdbbfabff9ae032078cfe5`
- Private backups: `database-before.dump`, `frontend-before.tar.gz`,
  `previous-index.html`, and `backend-before.json`. The container backup contains
  sensitive configuration and must not be published or committed.
- Additive release override: `compose.release.yml` in the release directory.
  Existing production Compose overrides and all environment values were retained.

For backend rollback, use the original Compose files recorded in the private
container backup plus an override selecting the rollback image, then recreate
only backend with `--no-deps --no-build --wait`. Leave PostgreSQL running.
Migration 053 is additive and can remain for an application rollback. Database
restore requires a separate maintenance decision; it would discard newer writes.

For frontend rollback, restore archived static files and atomically replace
`index.html` with `previous-index.html`. Keep installers and hashed assets.
The published Salt state does nothing until explicitly invoked and can remain.

## Follow-Up: Department Ping Timeout

- Deployed backend image `backend-backend:release-patch-ping-20261001` using
  the additional private `compose.patch-ping.yml` override in the release directory.
- Department `test.ping` now uses one authorized exact-ID probe instead of
  serial per-device probes. Individual results and history are preserved.
- Scoped probes include Salt's `tgt_type: list`, a one-second response timeout,
  a one-second job-gather timeout, and a five-second HTTP deadline. The live Salt
  API required `tgt_type`; `expr_form` alone did not match the requested ID list.
- Full backend tests passed. Live read-only Salt probes returned mixed online
  and offline results in approximately 2.6 seconds. This does not establish SSH
  authentication or successful endpoint updates.
- Backend health is good, public health reports database up, and signed-out
  protected requests return 401. Authenticated browser execution was not tested.
- Existing environment, mounts, ports, and migration files were verified unchanged.
  PostgreSQL was not restarted. No endpoint services or packages were changed.
- Rollback image: `backend-backend:rollback-patch-ping-20261001`. Removing the
  follow-up override also selects the preceding patch-workflow release image.