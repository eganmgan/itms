# Current application cleanup — 2026-09-17

## Preserved baseline

The main frontend is the working application. Keep its login, dashboard, device
directory/detail, patch, security, employee, gatepass and assistant components,
including their supporting APIs, tests and installer workflows. The detached
deployment worktree is not a reliable current baseline.

## Removed after dependency checks

- `frontend/src/components/AppSidebar.tsx`: no importers; the application uses
  `AppHeader`.
- `frontend/src/assets/hero.png`: no source, stylesheet, test or config references.
- Legacy backend files:
  - `backend/pkg/saltapi/client.go`
  - `backend/pkg/wazuhapi/client.go`
  - `backend/pkg/openscap/parser.go`
  - `backend/pkg/pdf/gatepass.go`
  - `backend/pkg/websocket/hub.go`
  - `backend/pkg/audit/audit.go`
  - `backend/pkg/middleware/auth.go`

The seven backend packages are absent from the dependency graph of all current
commands and internal packages, including their tests (373 packages inspected).
The active `pkg/mattermost` integration is retained. All removed files were tracked
and clean before removal; pre-existing changes and untracked work were preserved.

## Backup

Original files are archived outside Git at
`$HOME/.local/state/itms/cleanup-20260917-123945.tar.gz`, mode 0600, in a private
directory. Archive paths are repository-relative. Restore only individually
reviewed files from this archive if needed; do not overwrite later work wholesale.

## Database and operational boundary

No live database tables, rows, migrations or seeds were deleted. No database object
was proven obsolete. Absence of a frontend caller does not establish that an API
or table is unused: agents, integrations, reports and migration history depend on
them. All current frontend page modules have active callers and remain in place.

Legacy public asset URLs, documentation-linked artifacts, sibling generated
builds, installers and rollback artifacts were retained pending a separate
compatibility audit. This cleanup is deliberately limited to proven unused code.

## Validation

- Full frontend tests, lint and TypeScript checks passed.
- Production frontend build passed into `/tmp/itms-cleanup-validation-dist`, not
  the normal build directory or served webroot.
- Full backend `go test -mod=readonly ./...` passed using the cached toolchain.
- Normal build and served `index.html` retained SHA-256
  `2bca1908deee62e1fa2f7d1a1e9b9673307c11f50300bb4a2d701e105521d451`.
- Live `/login` and `/api/health` returned HTTP 200.

No deployment, service restart, commit or push was performed. The working site
remains on the same served files; the next release should build from this cleaned
main source rather than an older detached worktree.