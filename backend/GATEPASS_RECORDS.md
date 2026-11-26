# Gatepass company records and historical documents

## Shared record updates (deployed October 8, 07:16 UTC)

Successful company, branch/location and department saves in Settings notify open
pages in the same browser, including other tabs on the same origin. Notifications
carry only an opaque revision ID; every consumer reloads its own authorized API.
Gatepass drafts, employee/master-data forms and admin asset option lists refresh
without resetting entered values. These lightweight option lists also refresh on
window focus. Historical gatepass snapshots remain unchanged.

Devices refreshes its branch/department directory and manual-stock choices on
actual record-change notifications, queueing a refresh if directory/connectivity
requests are busy. Its existing no-focus-refresh/no-polling behavior is preserved.
Other browsers do not receive storage notifications; opening/reloading the relevant
page fetches current authorized records. This is not a server-push subscription.

The shared-records-20261008 frontend release preserves existing production role
checks. All 915 frozen frontend tests passed (2 skipped), along with types, lint,
production build and a synthetic two-tab Settings-save-to-Gatepass check. Verified
42 served files and 15 routes; backend, database and installers were unchanged.
No production company or branch was created during verification.

## Single-character suggestions and record refresh (deployed October 8)

Deployed at 06:53 UTC in the frontend-only gatepass-suggestions-20261008 release.
At 06:58 UTC, gatepass-branches-20261008 updated the add-record label to include
branches. Gatepass and manual-entry tests passed (64 tests), including new origin
and destination branch selection after refresh without discarding draft values.
The follow-up verified 42 published files and 15 routes with no backend or database
changes.
The gatepass form now offers saved-record suggestion menus from the
first typed character in its combined search, sender and receiver companies,
origin and destination branches, recipient, asset ID, item name, serial number,
department and IT approver. Matches include saved names, codes, asset tags and
company metadata. Click or arrow keys and Enter select an existing canonical ID;
Escape dismisses suggestions. Unknown text is not a new master record.

Company selection can precede asset selection. Changing a company clears
incompatible linked choices, and creation still requires a saved asset, matching
origin and valid movement details. Item, serial and department suggestions select
the corresponding asset rather than editing its inventory metadata. Each picker
has independent search, so a query in one field does not hide another field's
choices. Historical documents remain read-only.

The Add company, branch or asset link opens existing Settings entry in a separate tab,
subject to its existing super-administrator access requirements. Refresh saved
records reloads authorized options without resetting the draft. Newly added
companies can then be selected as receiver; arbitrary typed text does not create
master data or grant access to an otherwise unauthorized record.
Branches are created under Settings > Branches / Locations with their company,
name and code, then become available in the matching gatepass branch suggestions.

Phone, purpose and dates remain manual because they are movement inputs rather
than saved option lists. All 37 focused gatepass/picker tests, types, scoped lint
and a production build passed. The frozen frontend suite passed 902 tests with
2 skipped; focused tests were rerun after preserving the live approver policy.
Synthetic desktop/mobile checks confirmed receiver and asset selection and draft
preservation on refresh. Published hashes verified for 42 files and 15 routes;
backend, database and installers were unchanged. No business records were created.
Authenticated verification of specific missing production records remains pending.

## October 8 search follow-up (deployed)

Frontend-only correction deployed at 2026-10-08 06:31 UTC. A reproduced loading
race left the asset and company fields blank when an exact saved asset name was
typed before `/gatepass/options` finished loading. The form now applies the latest
typed search to the returned authorized records. The existing account/generation
guards still discard responses after sign-out; no records are inferred or written.

The frozen candidate differs from the preceding gatepass frontend in exactly the
page and its test. All 22 gatepass tests, types, scoped lint and fresh reproducible
production build passed. All 42 static files and 15 SPA routes were verified after
publication. Frontend entry: `index-DpczXiA7.js`. Backend/database containers and
installers remained unchanged; no backend restart or database write was performed.

Fresh frontend backup, source and artifact hashes, publisher and deployment result
are retained in `~/.local/state/itms/releases/gatepass-search-20261008`.
Its `publish.cjs verify` is the current read-only frontend verifier; the preceding
combined release's frontend checks now describe a historical bundle.
The live browser loaded the new entry but remains signed out, so authenticated
form acceptance is still pending. The reported asset's saved company and branch
links were checked read-only and were present; no master-data repair was needed.

## October 8 release (deployed)

Gatepass autofill was deployed at 2026-10-08 06:21 UTC. The release uses the
retained production backend/frontend sources plus only the four gatepass
implementation/test files. Existing production authorization is preserved:
the separate pending admin-permission changes were not published. Production
approver defaults and choices remain `super_admin` and `it_team`.

- Backend image: `backend-backend:release-gatepass-autofill-20261008`.
- Frontend entry: `index-CFUZndZM.js`; all 42 static files and six SPA routes verified.
- Full frozen backend suite passed. Frontend: 886 passed, two skipped; types,
  scoped lint and production build passed. An unchanged Patch test failed once
  on confirmation-button timing, then passed alone and in the full rerun.
- Gatepass SQL prepared successfully against the live schema in a read-only
  transaction. Backend health and unauthenticated route guards passed.
- PostgreSQL identity/start time, business counts, migrations, installers and
  backend runtime settings were verified unchanged. No gatepass was created.
- Fresh verified database, frontend and private runtime backups, frozen source,
  artifacts and deployment result are retained under
  `~/.local/state/itms/releases/gatepass-autofill-20261008`.

The release's `release.cjs verify` is read-only. Recovery uses the captured prior
active Compose file chain and the backed-up frontend entry, preserving existing
database environment and SSH overrides; no database restore is required. Do not
publish an older release helper or the unrelated dirty main worktree.

The live browser loaded the new bundle but is signed out. Authenticated autofill
using actual saved records and actual PDF downloads remain unverified. Synthetic
desktop/mobile autofill passed before release. Phone, dates and purpose remain
manual; missing master data still requires correction. The local-only section
below records implementation history and is superseded by this deployment status.

## October 8 autofill update (local only)

Not deployed. A unique exact asset tag, serial, ID or name entered in the saved
record search now selects that authorized asset and fills its saved company,
origin, item name, serial and department. Company and partial searches filter
choices; ambiguous matches never select an arbitrary asset.

Asset options include optional `assignedUserId`, restricted to an active employee
in the caller's authorized company scope. The form defaults the recipient to that
saved employee and the destination to the employee's valid saved branch. It does
not infer a destination from the asset's origin. A sole eligible sender-company
approver is preselected; multiple approvers require a choice. These are editable
draft defaults, not approvals. Explicit recipient and approver choices survive
asset changes; automatic values are recalculated or cleared.

Contact phone remains manual because users have no canonical phone field. Purpose,
dispatch date and return date remain deliberate movement inputs. Missing company,
branch, assignment or department data must be corrected in the saved records;
this change does not invent values or modify master data. Backend and frontend
updates are both required for assigned-recipient autofill. No migration is needed.

## September 23 update (deployed)

Deployed with the coordinated September 23 release. Gatepass drafts now include
a typed search for saved companies/assets by name, company code, asset tag or
serial. Selections remain canonical IDs, not arbitrary typed identities.

New Gatepass numbers use `<company>-GP-<YYYYMMDD>-<12 hex characters>`.
The prefix comes from the asset company's canonical `entities.short_code`,
never client text. `ZBL` stays `ZBL`; the existing `ZTEC` code is rendered as
`ZTECH`. Missing or invalid sender codes block creation. The resolved sender
code is stored in the snapshot. Existing numbers and historical snapshots are
unchanged. Entity options now put the saved short code in `reference`.

The frontend can display the sender company from an origin-branch selection
before choosing an asset. Creation still requires an asset and matching origin.
Selecting a recipient fills its saved destination branch when authorized and
consistent; otherwise an existing same-company selection is retained or a
conflicting selection is cleared. No destination is inferred from the asset.

The original migration-047 implementation below was subsequently deployed on
September 22; see the coordinated release review for the September 23 follow-up.
Authenticated production workflows still require user sign-in verification.

Implemented locally; **not deployed**. PostgreSQL migration
[047_gatepass_record_snapshot.sql](db/postgres_migrations/047_gatepass_record_snapshot.sql)
must be applied through the separately authorized release process before this
backend is used. No migration or production operation was performed here.

## Authoritative sources

The inspected canonical schema uses `entities.full_name` as the saved company
name. It has no separate legal-company registry or verified registered-address
field. This implementation does not invent those details.

- Sender: selected `assets.id` → `assets.entity_id` → `entities.full_name`.
- Origin: default to the asset's saved `location_id` only when it resolves to an
  authorized, active branch of that same company. Missing/inconsistent links
  require an explicit matching branch selection. An explicit origin selection
  is permitted within the asset company, not across companies.
- Receiver: selected recipient `users.entity_id` and/or destination
  `locations.entity_id` → `entities.full_name`. If both are selected they must
  agree. The person name is printed separately, never as a company name.
- With neither recipient nor destination selected, the user must explicitly
  select an authorized saved entity. No first-option default or requester-company
  fallback. Conflicting explicit selections fail rather than win by precedence.
- Asset tag, name, serial and department come from the selected asset. Branch
  names, recipient name/employee code, and designated IT approver name come from
  selected records. Names are never matched to IDs by text, email or hostname.

External vendor/supplier companies without a saved authorized entity mapping
are **not supported**. There is no recipient-to-supplier relationship in this
schema; create/correct the appropriate master records using existing authorized
administration, or extend that model separately. Do not select an unrelated
entity just to bypass the missing mapping. Inactive entities/locations/users and
users with no entity are not offered, including approvers without an entity.

## API contract and authorization

`GET /api/gatepass/options` returns `{items: [...]}` containing `kind`, `id`,
`name`, `entityId`, `locationId`, `reference`, `serial`, `department`, and `role`.
Kinds: `entity`, `branch`, `asset`, `recipient`. IT approvers are recipients with
the `it_team` or `super_admin` role. No emails or credentials are returned.

Options and creation require `super_admin` or `it_team`. Super-admin sees all
active companies. IT scope is primary entity plus `user_entity_access` grants;
every asset, branch, recipient and approver must belong to that scope. The options
query uses an eight-second deadline, no-store response, and currently returns all
authorized records without pagination. Very large directories may require a
future scoped search/pagination endpoint; timeout fails closed.

`POST /api/gatepass` accepts:

- Required: `assetId`, `approverId`, nonblank `purpose`, ISO `issueDate`.
- `originBranchId`: optional only if the asset has a valid saved branch.
- `recipientId`, `recipientBranchId`: either/both optional; if neither resolves
  the receiver, `receiverEntityId` is required. All provided mappings must agree.
- Optional `returnDate` (ISO date, not before issue date), `contactNumber`
  (manually entered; users have no canonical phone field here).

Old free-text-only creation payloads are no longer sufficient. Client company,
asset and person names or client snapshots are ignored. Creation re-reads scoped
master records in a repeatable-read transaction and persists the server-built
`record_snapshot` with the pass atomically. Data reflects that transaction's
snapshot; later master edits do not rewrite it. Gatepass numbers use an issue-date
prefix and random 12-hex suffix under the existing unique index, not COUNT+1.
There is no automatic retry; an uncertain save must be checked in the list.

`recordSnapshot` is returned on creation and list responses. Version 1 contains
sender/receiver entity IDs, names and source, asset/origin/destination/recipient/
approver record snapshots, and optional return date. This is not a legal company
verification service: administrators remain responsible for master-data accuracy.
Existing list/approval/completion access remains requester-entity scoped.

## Historical rendering and signatures

Existing rows remain NULL; **no heuristic historical backfill**. List responses
represent these as version 0 with empty names. The UI displays an incomplete
historical record and blocks its official PDF download. It does not resolve old
free text against today's master records. A reviewed historical reconciliation
workflow is outside this change; it must not silently rewrite signed documents.

New previews/PDFs use persisted snapshots, not demo asset lookups, current master
names or editable print fields. Drafts cannot export an official document. Issue
and return dates are not fabricated. API/sign-in failures show no demo passes or
audit entries. The PDF remains a movement form, not proof of approval or signature.

The three blank handwritten-signature areas and paper-signature completion
confirmation are preserved. A printed approver name is not a signature. Creation
no longer fills `issuer_signed_*` automatically. Existing approval/completion/
upload implementations and their historical signature metadata are otherwise
unchanged; no electronic-signature claim is made.

## Offline validation

Dedicated SQL-mocked Go tests cover role/scope query constraints, company
resolution/conflicts, missing mappings, forged client names, snapshot persistence,
historical serialization without current-master joins, and date validation.
Frontend tests cover official snapshot rendering, legacy blocking, no demo
fallback, authorized ID-only creation, unknown/conflicting company selection,
read-only historical fields, and the existing handwritten-signature workflow.
These are not live PostgreSQL/migration or production/browser end-to-end tests.