# Manual Entry live release — 2026-09-19

## Settings navigation follow-up (live)

The frontend was subsequently updated: **Manual Entry** is now **Settings** at
`/settings`, with employee addition/search at `/settings/employees`. The old
manual-entry URLs remain aliases. Admin computers, Suppliers and Installation
scripts no longer appear as separate primary-navigation buttons; their cards
and workflows remain inside Settings. Super-admin child pages provide a Back
to Settings link. Account settings remains a distinct profile-menu action.

Super-admin-only Settings access and existing admin/super-admin permissions on
the underlying administration pages are unchanged. No data or features were
deleted. This was a frontend-only publication, with no backend restart or
database changes.

- Current entry: `assets/index-CBZ5kHId.js` (replaces the entry recorded below).
- Validation: 535 frontend tests passed, one skipped; TypeScript, lint and build
  passed. Live HTML matched the build, entry assets and canonical/legacy routes
  returned HTTP 200, and API health remained good. Live browser checked signed-out
  `/settings`; authenticated navigation remains covered by regression tests.
- Previous frontend backup:
  `/home/itms/.local/state/itms/releases/settings-navigation-20260919`.
- Old hashed assets and installer files were preserved.

## Status

User-authorized live deployment completed. This supersedes the **not deployed**
status in earlier local-validation notes. No Git commit or push was performed.

- Backend image: `backend-backend:release-manual-entry-20260919`.
- Image ID: `sha256:e9dadb2c49014c84a94e7b5e53995cb9fd0ba0d199f481e2836dd8e25ef11130`.
- Backend binary SHA-256: `6259c7c283b1599abc5e1a2501247d5fa2e07cb072eb77f138601302f1d6af15`.
- Frontend entry: `assets/index-RiIAs6bx.js`; stylesheet: `assets/index-CD-UQeAV.css`.
- Published HTML SHA-256: `938dbaf4b37bce898c6ea81ea19e1ae4537f111a00c59e4e1559b0b43c336329`.
- PostgreSQL migrations 041 and 042 applied successfully by backend startup.

## Available pages

- `/admin/manual-entry`: super-admin-only entry workspace.
- `/admin/manual-entry/employees`: employee addition and server-side search.
- `/admin/assets`: computer, financial, lifecycle and warranty management.
- `/admin/suppliers`: supplier directory; writes remain super-admin-only.
- `/admin/scripts`: entity-scoped storage-only installation-script records.

The latter three retain their existing admin/super-admin read permissions.
The release also includes faster deferred directory connectivity, lazy page
loading, Patch controls above the stream, and remote/network inventory display.

## Startup safety correction

Release preflight found destructive department reconciliation in startup seeds.
It was removed before deployment. Startup now inserts missing defaults without
deleting custom departments, unassigning users/assets, overwriting customized
master-data fields, or removing additional permission grants. Built-in required
grants remain seeded; existing account credentials are preserved.

Eleven database-package regression tests and the full offline backend suite
passed after this correction. Earlier integrated frontend validation passed
491 tests with one skipped, plus TypeScript, lint and production build.

## Deployment safeguards

- Effective Compose environment compared equal to the running backend in memory;
  values were not printed. Historical migration hashes matched the old image.
- Durable private backup directory:
  `/home/itms/.local/state/itms/releases/manual-entry-20260919` (mode 0700).
- Database custom-format backup: `postgres-itms.dump` (mode 0600), validated
  with the existing PostgreSQL container's `pg_restore --list` (435 lines).
- Previous served frontend: `frontend-public.tar.gz`, excluding installers.
- Private runtime inspection, Compose and environment backups are in the same
  restricted directory. Never publish these files or include them in Git.
- Rollback image tag: `backend-backend:rollback-manual-entry-20260919`, pointing
  to previous image `sha256:dfdb5cb4c62bba927692f65adfba783d95acd1cab42990588b9ff7c5fba6a07e`.
- Release image overlays the tested binary/migrations on the known runtime.
  Build context explicitly excludes database/configuration backups.
- Backend-only Compose recreation used the private `compose.release.yml`
  override. PostgreSQL was not recreated or restarted.
- Hashed frontend assets were copied first; HTML was replaced atomically.
  Old hashed assets and the installer directory were retained.

## Live verification

- Backend container healthy; `/api/health` reports database up.
- Served HTML equals the generated build byte-for-byte; binary hash verified
  inside the running backend.
- Login and all five administration URLs returned HTTP 200 through nginx.
- Signed-out user, admin asset/script/supplier and directory connectivity APIs
  returned HTTP 401.
- Before/after counts: 2 users, 2 assets, 11 departments. Migration count moved
  from 43 to 45. PostgreSQL container identity remained unchanged and healthy.
- A fresh browser page (without preview fixtures) displayed the live Manual
  Entry sign-in guard. Authenticated live forms and actual employee creation
  remain unverified; no test employee or other business record was created.

## Rollback caution

Restore assets before publishing the archived HTML; never remove installers.
Use the backed-up runtime configuration with a deliberately selected image.
The old binary contains the destructive seed behavior fixed in this release:
do not blindly restart it after custom departments have been created. Review
and prefer a forward fix or a rollback build retaining the safe seeding patch.
Do not restore the database snapshot automatically: doing so would discard
records created since deployment. Migrations are additive and remain applied
unless a separately reviewed recovery requires otherwise.