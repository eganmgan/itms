# Bulk employee accounts and custom passwords

## Live status

### Template follow-up - 12:58 UTC

Frontend-only publication on September 24, 2026 renamed GLPI CSV import to
Bulk asset. Both Bulk asset and Bulk employee accounts now provide a static
Download CSV template link. Fill the downloaded file and upload it on the same
page: asset files use semicolons; employee files use commas and the three headers
below. The schemas are separate and cannot be interchanged. Downloads contain
headers only, with no sample records. Original GLPI exports remain supported.

Entry: `assets/index-CQAyeR-o.js`. HTML SHA-256:
`bd6497a078f9fceddd802fbe2958caaec9598ed5728cd069370771215e0730aa`.
All 43 frontend files passed HTTP byte verification. The live browser loaded
the new entry and fetched both templates successfully. Backend and PostgreSQL
container identities/start times/health and installer hashes were unchanged.
No backend runtime, password, migration or production-record changes were made.

Validation: 25 Settings tests, focused Go parser/template tests, TypeScript,
scoped lint and production build passed. Tests fill the actual downloadable
templates and parse them with their respective backend parsers; header-only
files and wrong-page templates are rejected. Isolated synthetic desktop/mobile
checks verified download names, headers, upload controls and no page overflow.
Authenticated production imports were not exercised.

Private release record and original frontend backup:
`~/.local/state/itms/releases/bulk-templates-20260924`.
The first publication failed HTTP verification because private umask masked
public directory and rollback-index modes, temporarily returning 403. Public
permissions were restored, the script corrected, and retry succeeded using the
verified original backup. Public directories must be 0755 and files 0644,
including a restored index; private backups remain private.

### Employee/password release - 12:18 UTC

Deployed September 24, 2026 at 12:18 UTC. Backend image:
`backend-backend:release-bulk-employees-20260924`, image ID
`sha256:e27e66a70716c3860950648c52acf3d86bc8ee2d5d240ca0cd7daba37d7db6a9`.
Frontend entry: `assets/index-DbK21fWD.js`. Served HTML SHA-256:
`74120a5e9b1938d03c87172457e5adb204e5f061672ef28789a0f62699ac26aa`.

Backend health/database up and all 41 frontend files verified over HTTP.
PostgreSQL container identity/start time, installer hashes and all 53 applied
migrations remained unchanged. Counts remained 3 users, 2 assets, 11 departments,
0 gatepasses, 1 request, 0 installation scripts and 0 stock items. No actual
employee creation, asset import or password reset was performed during deployment.

## Bulk email and employee creation

Settings > Bulk employee accounts accepts comma-delimited UTF-8 CSV, up to 1 MiB
and 1000 records. Download CSV template supplies these headers:

```csv
emp_id,full_name,email
```

Only these three columns are accepted. Do not put passwords in CSV files.
Select an active company for the entire file, preview, select up to 200 ready
rows, explicitly confirm and create. Preview lists row-level errors for invalid
fields, hosted-domain mismatch and duplicate/existing employee IDs or emails.
Existing accounts are never updated, renamed or overwritten. Repeat preview for
subsequent batches. Existing IDs/emails are blocked after a successful import.

New records have employee role, inactive status, no password, and an explicit
company access link. No guessed departments, locations, employee IDs or names.
Preview is read-only. Creation replans under a serializable transaction and
requires the reviewed digest; selected records and their access links commit
atomically. Failed/ambiguous requests require preview again, not automatic retry.
Uploads and previews stay in page memory; responses are no-store.

API, exact super_admin only:

- `POST /api/admin/employees/preview`: `{csv, entityId}`.
- `POST /api/admin/employees/import`: `{csv, entityId, rows, digest}`.
- Row numbers are one-based data record numbers, excluding the header.
- This is separate from the legacy `/users/import` upsert endpoint.

## Custom password setup

Settings > Employee addition / search > Search employees > Password & access
opens the employee detail/reset form. Enter and confirm a unique custom password.
For inactive imported accounts, explicitly tick Activate employee after setting
this password when access is approved. Activation and password update use the
same administrator PATCH; activation is never implicit. Detail lookup also works
for employees outside the directory's first 200 records.

At the user's explicit request, the shared password policy no longer requires
uppercase, lowercase, numbers or symbols. New passwords/passphrases require
8-72 UTF-8 bytes and no leading or trailing Unicode whitespace. Internal spaces
are allowed. The 72-byte maximum is bcrypt's storage limit. Prefer long, unique
passphrases: permitting simpler inputs does not make short predictable passwords
secure. Existing password hashes are unchanged. This shared validation applies
to password creation/reset and configured default-password validation, not merely
the UI. Existing administrator authorization, masked fields, confirmation and
secret-free result messages remain. No next-login password-change enforcement or
session revocation was added.

## Asset import follow-up

The actual source CSV files were not available in the workspace at completion.
User chose to upload them into the server workspace; file paths are still needed.
No claim is made that all rows of the earlier summarized attachments were audited.

GLPI preview already identifies missing/placeholder/duplicate tags, duplicate
serials, unmatched entities, ambiguous categories, unsupported status and invalid
field lengths/dates. Those issues block affected rows. Automatic category,
unassigned employee/technician and unmatched location warnings require review but
do not themselves block valid records. Existing assets are not overwritten.
Source employee/location values remain in notes when not matched. Asset saving
must use the complete CSV and reviewed selections, never reconstructed screenshots.

## Validation and recovery

Full offline backend suite passed; frontend 761 passed, 2 skipped, 35 files.
TypeScript, scoped lint and production build passed. Focused tests cover password
hashing, reset input policy, bulk parsing, exact roles, duplicate revalidation,
atomic rollback, selected creation, failed requests and explicit activation.
Synthetic browser checks at 1440px and 390px verified bulk preview, blocked rows,
confirmation and creation with no horizontal page overflow. These do not replace
authenticated production import/reset verification. Existing Vite config and
large-chunk warnings remain non-fatal.

Private release/backups: `~/.local/state/itms/releases/bulk-employees-20260924`.
Contains active compose override, deployment result, database dump, frontend and
private runtime archives; archive listings and backup checksums validated.
Keep runtime snapshots private. Previous backend image is
`backend-backend:release-glpi-autocat-20260924`, with its compose override in
`~/.local/state/itms/releases/glpi-autocat-20260924`.
Any approved rollback must preserve effective runtime settings, recreate backend
only with `--no-deps --no-build --pull never --wait`, and publish the fresh backed-up
frontend index last. Preserve PostgreSQL and installers; do not restore the
database as a routine application rollback. Existing simpler password hashes
remain verifiable by the prior bcrypt implementation, but its older composition
policy would again restrict subsequent password changes.