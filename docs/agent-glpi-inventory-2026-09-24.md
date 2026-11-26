# Agent inventory and GLPI import - September 24

## Status

Latest frontend follow-up, September 24 at 12:58 UTC: Settings now calls this
page Bulk asset. Download CSV template supplies a blank semicolon-delimited
asset template accepted by the existing upload/preview/import flow. Bulk
employee accounts has its own comma-delimited employee template; use each
template on its corresponding page. Existing GLPI exports and API routes are
unchanged. No production import or backend restart occurred. See
[template release details](bulk-employees-passwords-2026-09-24.md#template-follow-up---1258-utc)
for validation, current frontend entry and recovery information.

Frontend and backend deployed with user approval on September 24, 2026 at
08:53 UTC. Only the backend container was recreated; PostgreSQL was not restarted.
All 53 migration files and the applied ledger were unchanged, with none pending.
No production import, installer publication, endpoint upgrade or endpoint command
was performed. No new schema migration was required.

### Automatic categories - 11:30 UTC

User requested automatic detection instead of mandatory manual category mapping.
The shared backend preview/import validator now suggests categories using explicit
equipment words in GLPI Type and Name. Keyboard, mouse, headset, adapter and
charger records suggest accessory; clear computer families and equipment names
suggest their corresponding categories. Matching is case-insensitive with word
boundaries. Accessory terms take precedence within a field (a laptop charger is
an accessory). Recognised Type/Name conflicts and ambiguous categories remain
blocked. Critical Asset, hostnames, operating systems and numeric model codes
alone do not establish laptop versus desktop.

Automatic detection runs separately for each record, including records with a
missing Type. The response includes `categorySource`: `type`, `name`, `manual` or
`unresolved`. Automatic suggestions carry a review warning and appear as
Automatic: category in row dropdowns. Nonempty manual overrides still apply to
all rows of the same Type; Auto-detect from CSV restores per-record detection.
Imports still require selected valid rows and explicit review confirmation.

- Backend: `backend-backend:release-glpi-autocat-20260924`; image ID
  `sha256:b7b7879423a29024b92961ba26ecf0cde0371efc87e56b4e8a2653b00b5954a3`.
- Frontend: `assets/index-CqHf-7Dp.js`; HTML SHA-256
  `0517fad857174454c8286676d1484aeb6a54a18b97096465901dab15d17d7549`.
- Full offline backend suite and 23 Settings tests passed, as did typecheck,
  scoped lint and production build. Synthetic desktop/mobile browser checks
  verified automatic labels, mixed missing-Type categories, unresolved blocking
  and no horizontal page overflow. Authenticated live import was not exercised.
- Backend health/database up and all 41 frontend files verified over HTTP.
  PostgreSQL identity/start time, all 53 migrations and installer hashes unchanged.
  Counts unchanged across this deployment: 3 users, 2 assets, 11 departments,
  0 gatepasses, 1 request, 0 installation scripts, 0 stock items. No import ran.
- Fresh private backups, active compose override and deployment result are in
  `~/.local/state/itms/releases/glpi-autocat-20260924`. Database and frontend
  archive listings and backup checksums passed. Previous backend recovery image
  is `backend-backend:release-glpi-20260924`, with its override in
  `~/.local/state/itms/releases/glpi-20260924`. Use the fresh frontend backup for
  paired recovery, preserving PostgreSQL/installers and effective runtime settings.

### Category mapping correction - 11:14 UTC (superseded above)

Frontend-only follow-up published on September 24. Category dropdowns now appear
beside each preview row and apply to all rows sharing that GLPI Type. Changing a
mapping automatically requests a fresh server preview, clears selection and
confirmation, and preserves pagination. Unmapped rows show Category required,
not Accessory / equipment. Failed validation keeps import disabled; duplicate
checks and explicit import confirmation remain unchanged. This earlier release
still required manual category mapping.

- Entry: `assets/index-2X16akTT.js`; served HTML SHA-256:
  `e52c905546d5a4a772c7a1bc3544a22e2e4f55792ce7f9ce7a284254bf76a3cc`.
- All 41 frontend files verified over HTTP. Backend/PostgreSQL container identity,
  start time and health, and installer hashes remained unchanged. No import ran.
- Backup and release record: `~/.local/state/itms/releases/glpi-category-20260924`.
  `frontend-before.tar.gz` retains the preceding frontend; its archive listing
  passed. The publication script restores the prior index on verification failure.
- All 22 Settings tests, typecheck, scoped lint and production build passed.
  Synthetic browser checks at 1440px and 390px verified category refresh, duplicate
  blocking and no horizontal page overflow. Production authenticated import was
  not exercised. Reload and reselect the source CSV to use the new frontend.

### Deployment verification and recovery

- Backend image: `backend-backend:release-glpi-20260924`.
- Image ID: `sha256:08d7fae61f4f96d5edea010cbeb0d30f4c193a75d5ab914abd42d6830389e480`.
- Frontend entry: `assets/index-D7fPWQew.js`.
- Served HTML SHA-256: `697b67affe70d29c0d72079a0912de23556a1a4e013c2087ced0dbb1f0c7dc07`.
- Backend health passed with database up. All 41 staged frontend files matched
  their live HTTP responses. The live browser rendered the login page and loaded
  the new entry bundle. Authenticated production workflows remain unverified.
- Business counts remained 2 users, 2 assets, 11 departments, 0 gatepasses,
  1 request, 0 installation scripts and 0 stock items. Installer hashes and
  PostgreSQL container identity/start time were unchanged.
- Signed-out accessory/software-permission reads and GLPI preview/import
  requests returned 401. No authenticated import was executed.
- Private release directory: `~/.local/state/itms/releases/glpi-20260924`.
  It contains the active `compose.release.yml`, `deployment-result.json` and
  validated backups: `backup/database.dump`, `backup/frontend.tar.gz` and
  `backup/runtime-private.tar.gz`. Runtime snapshots contain secrets; keep them
  private. Database archive listing and backup checksums passed before cutover;
  a database restore was not performed.
- Recovery reference: the preceding safe backend image is
  `backend-backend:release-fixes-20260923`, selected by
  `~/.local/state/itms/releases/fixes-20260923/compose.release.yml` alongside the
  backend base compose file. Any authorized rollback must recreate only backend
  with `--no-deps --no-build --pull never --wait`, preserving its effective runtime
  environment and PostgreSQL. Restore frontend assets from the fresh archive,
  publishing its index last and preserving installers. Do not restore the
  database or use older images with destructive startup seeds as a routine rollback.

## Agent collection and freshness

- Generated commands explicitly select the server's Python or PowerShell
  collector and a six-hour refresh interval. Existing collector defaults collect
  software, services, hardware, network and update metadata within platform scope.
- A read-only SHA-256 comparison on September 24 found all five published files
  under the live installer directory differ from the repository versions.
  Frontend/backend publication did not update those files. Publish the reviewed
  installers and collectors in a separately authorized release before treating
  collector changes as available to new installs.
- Existing agents reuse their installed collector. Publishing files does not
  upgrade endpoints. Plan and authorize endpoint upgrades separately.
- Device Directory now shows inventory report age separately from live
  connectivity. Device details show section freshness and a read-only Services
  tab. Apps & Services shows application/service-list freshness.
- Recent means within 12 hours, a display threshold allowing two default refresh
  intervals. It is not proof of complete collection, online connectivity, current
  software versions or security compliance. Partial/failed/uncollected states
  remain explicit. Future or malformed timestamps have unknown freshness.
  Directory age uses recorded agent `last_seen`, not a server receipt guarantee.
- Hardware and network collection remain best effort. See
  [agent-inventory-coverage.md](agent-inventory-coverage.md) for platform limits.
  Standalone chargers, bags, adapters and disconnected accessories cannot be
  reliably inventoried by an endpoint agent; use asset/stock records and GLPI.

## Settings workflows

Settings includes **GLPI CSV import** and **Accessories & equipment**.
Both require the exact verified `super_admin` role, including backend checks.

The upload accepts UTF-8 semicolon-delimited GLPI exports, with quoted multiline
comments, an optional UTF-8 BOM and the trailing empty column used by the provided
exports. Maximum 8 MiB and 5000 records; import at most 200 selected rows per batch.

1. Upload one export and preview it without writing records.
2. Review the automatically detected categories. Override unresolved or incorrect
  categories as needed. `Critical Asset` is not assumed to mean laptop; a clear
  equipment name can resolve it. Missing types use each record's name. Manual
  overrides apply to an entire source type, so mixed groups must not receive an
  inappropriate blanket override; correct/split them when needed.
3. Wait for automatic revalidation after mapping changes, inspect source fields,
   issues and warnings, then select rows. Preview CSV remains available for retries.
4. Confirm the review and import. The server re-reads inventory and requires the
   current preview digest. Any selected-row issue blocks the whole batch.
5. Preview again for remaining rows. Previously imported tags are blocked.

Import behavior:

- Creates canonical assets only, never updates/deletes existing assets or stock.
- Computes category membership from the reviewed suggestion or manual override:
  laptop/desktop/server are computers;
  accessory/monitor/printer/scanner/phone/network/cctv/ups are non-compute assets.
- Maps Deployed to `in_use`, Scrapped to `scrapped`, In Stock to `in_stock`.
  Other/missing statuses are blocked. Conflicting comments need human review;
  comments never override lifecycle status automatically.
- Requires exactly one active entity matching the source full name after
  case/outer-whitespace normalization. No entities are created automatically.
- Matches locations only by exact full name within that entity. Unresolved
  locations are left unassigned and retained in source notes, with a warning.
- Does not infer employee/technician identities from display names, usernames or
  parenthesized GLPI numbers. These source values remain in notes; assignments
  require separate canonical user reconciliation.
- Blocks missing/placeholder tags, case-insensitive duplicate tags and duplicate
  nonempty serial numbers, including matches against existing assets and stock.
  Does not invent tags, silently truncate fields or overwrite duplicate records.
- Preserves exported fields in JSON source notes, including comments, firmware
  labels, GLPI reference numbers embedded in names and source type. The firmware
  label is not treated as a measured BIOS version.
- Preserves warranty start without inventing duration or expiry; computer OS is
  stored without an agent timestamp or fabricated app/service inventory.
- Writes assets, compute details and actor-attributed history in one serializable
  transaction. No automatic mutation retries. After an ambiguous response,
  preview again to detect already committed records.
- Source files and previews are held in component memory, not browser storage.
  Backend responses are no-store. Source contents are not committed to Git.

The accessory list searches canonical non-compute assets and manual stock,
retaining each record's source. It is read-only and does not merge those stores.
Unassigned imported computers remain available under Settings > Computers;
the user-based Device Directory only lists computers assigned to active users.

## Attached export review

The visible export samples contain repeated tags (including different equipment
sharing a tag), missing tags/owners/types, placeholder identifiers, mixed serial
and asset-number fields, and lifecycle/comment contradictions. These require
review before import. Parenthesized numbers are not assumed to be employee IDs.
The accessory attachment is summarized in chat, so this is not a complete-file
audit or a claim that every exported row is import-ready.

## API

- `POST /api/admin/glpi/preview`: `{csv, categories}` returns `{rows, digest}`.
- `POST /api/admin/glpi/import`: same CSV/mapping plus `{rows: [1, ...], digest}`;
  row numbers are one-based CSV record numbers, not physical multiline line numbers.
- `GET /api/admin/accessories?page=1&search=...`: 50 records plus `hasMore`.

Preview and import are sensitive administrator operations. Retain database and
served-file backups before publication/import. Do not run the live readiness
smoke script as a read-only check; it can create records and execute commands.

## Validation

- Full offline Go suite passed; focused access, parser, duplicate/revalidation,
  transactional rollback and computer-import tests passed.
- Full frontend: 752 passed, 2 skipped, 35 files. TypeScript and production build
  passed. Focused lint passed after fixing the upload cleanup warning.
- 33 mocked collector tests passed. No native Windows/macOS endpoint execution,
  production import or real-device inventory verification is claimed.
- Existing Vite configuration and large PDF chunk warnings remain non-fatal.
- Isolated production-build browser checks covered CSV file selection, category
  mapping, preview/confirmation and accessory search with synthetic responses at
  1440px and 390px widths. No horizontal page overflow was detected. These are UI
  checks, not production API or real-export import verification.
