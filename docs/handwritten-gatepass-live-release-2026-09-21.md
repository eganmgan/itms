# Frontend live release — 2026-09-21

## Status and scope

User-authorized frontend-only deployment completed. No backend or database
restart, migration, business-data write, Git commit or push was performed.

- Purchase and warranty date pickers retain strict YYYY-MM-DD validation for
  years 0001–9999, including incomplete native-date input protection.
- Local validation errors no longer display write-failure recovery guidance.
  Failed writes are not automatically retried.
- Add User is shown only on the Employee Directory tab, as its sole header
  action; directory search, list and details remain available.
- Gatepass preview/PDF provides blank handwritten signature, name and date
  spaces rather than electronic-signature claims.
- Completion requires manually entered receiver/security names and confirmation
  that the printed gatepass was signed by all three signatories. No electronic
  signature is created. Existing completion API is unchanged.
- Gatepass listing accepts the backend's paginated response envelope.

## Release identity and rollback

- Served directory: `/var/www/itms`.
- Entry: `assets/index-Bl_A2iNc.js`.
- Stylesheet: `assets/index-Bi1DDM7q.css`.
- HTML SHA-256:
  `15918fa4af93fc094539c6350e153d4c8d926b2e4a133e43162119d62d1211c0`.
- Private release directory (mode 0700):
  `/home/itms/.local/state/itms/releases/handwritten-gatepass-20260921-eXJ3Vr`.
- Previous frontend archive: `frontend-public.tar.gz` (mode 0600), excluding
  installers. Archive listing validated; previous HTML also retained separately
  as `previous-index.html`. The new build is retained in `build/`.

Built from the main frontend working tree with Vite `envDir: false`, not from
the stale detached deployment worktree. Assets were published before an atomic
HTML replacement. Old hashed assets and installers were preserved. Rollback can
restore archived static files, then atomically restore previous HTML. Do not
remove installers or restore/restart the database for a frontend rollback.

## Validation

- Before release: 546 frontend tests passed, one skipped; TypeScript and lint
  passed. Two initial full-suite failures passed in isolation and on full rerun.
- Fresh production build passed; existing large PDF bundle size warning remains.
- Live login, Settings, admin assets, employees and gatepass paths returned HTTP
  200 and matched the built HTML byte-for-byte.
- All 36 generated asset files matched live HTTP responses byte-for-byte.
- API health returned HTTP 200 with database up.
- Signed-out users, gatepass and admin assets APIs returned HTTP 401.
- Backend and PostgreSQL container IDs/start times were unchanged; both healthy.
- Integrated-browser attempt to server loopback returned connection refused;
  browser rendering and authenticated live workflows were not verified during
  this deployment. Server-side HTTP checks succeeded. No test records created.