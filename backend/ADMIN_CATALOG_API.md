# Admin suppliers and installation-script records

## September 23 update (deployed)

This section supersedes the original entity-required and `sh`/`sls` contract
below. Migration **050_shared_installation_scripts.sql** makes script ownership
nullable. Settings no longer asks for an entity; new records are shared and
require `super_admin` to create or edit. Entity admins may read shared records
but cannot edit or claim them. Existing scoped records retain their ownership
and existing scoped access checks; no records are automatically made global.

New or changed script types accept **`sh` only**. Existing `sls` bodies are not
converted or deleted and cannot be executed through installation-script APIs.
Compatible-device listing, review and execution accept either shared scripts
or scripts owned by the device's entity. Authorization still applies to the
target device. Script execution remains super-admin-only, hash-reviewed and
explicitly confirmed, with durable request IDs and no automatic retry.

Migrations 048 (category), 049 (run records) and 050 are required in addition to
042. Saving remains storage-only; execution is a separate Apps & Services
operation. Migrations 048-050 and the matching backend/frontend were deployed
with explicit user approval on September 23. No live script execution was
performed. See the coordinated release review for backup and verification details.

## Pages

- `/admin/assets`: the existing manual computer page, now with explicitly separate
  **Financial & Administrative Information**, **Management Asset Lifecycle** and
  **Warranty Information** sections in both edit and detail views. Supplier
  contact details can be loaded without leaving an unsaved asset form. The
  supplier directory link opens its separate administration page.
- `/admin/suppliers`: list, detail, add and edit supplier records.
- `/admin/scripts`: list, detail, add and edit **storage-only** application
  installation-script records. Saving does not install, execute, publish to Salt,
  schedule, or grant execution rights. No delete controls or endpoints were added.

The manual asset sparse PATCH/null clearing/decimal cost/warranty contract is
unchanged. Lifecycle uses the existing status, assignment, management and notes
fields, not a new lifecycle engine.

## Authorization and schema decision

All new API handlers require authenticated, literal `admin` or `super_admin`.
UI routes verify `/api/auth/me` before requesting records. Other roles and
case/whitespace aliases are rejected. UI checks do not replace server checks.

Canonical suppliers are defined by PostgreSQL migration 028: `id`, globally
unique `name`, `contact_info`, timestamps. They have **no entity ownership**.
The existing inventory supplier mutation handlers require `super_admin`.
The new endpoints preserve that rule: both admin roles can read the global
business-contact directory; only `super_admin` can add/edit global suppliers.
Entity admins must request shared-record changes from a super administrator.
This is intentional, not an entity-scoping bypass. No supplier migration or
duplicate supplier table was introduced. Legacy supplier handlers are unchanged.

The Salt BFF's existing library uses `scripts(name,type,created_by,updated_at)`
and `script_variants(os,body)`, with `sh`/`sls` types and
`default`/`Ubuntu`/`Debian`/`Rocky Linux` platforms. Its separate user schema has
`admin`/`operator`/`viewer`, its authentication uses an email header, and its
records are consumed by run/schedule execution. It has neither canonical entity
ownership nor the requested `super_admin` boundary. Reusing those CRUD endpoints
or inserting scoped drafts into those executable tables would be unsafe.

Pending PostgreSQL migration **042_admin_installation_scripts.sql** therefore
adds only `admin_installation_scripts` in the canonical backend. It preserves the
library's name/type/os/body vocabulary and adds entity ownership and description.
One record stores one application/platform variant. UUID IDs and an isolated table
keep records out of existing execution consumers; no existing execution code,
roles or routes were changed. Migration 041 remains the manual-assets prerequisite.
**No migration was applied and nothing was deployed or restarted.**

Scripts are visible/writable to `admin` within its primary entity or explicit
`user_entity_access` memberships; `super_admin` is global. Detail/PATCH selects
include the scope predicate (out-of-scope and missing IDs both return 404).
Explicit out-of-scope list filters/create/transfer destinations return 403.
Writes require an active destination entity. PATCH checks both the locked source
record and destination scope. Entity selection reuses the scoped asset options API.

## Endpoints

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/admin/suppliers` | Paginated global directory |
| GET | `/api/admin/suppliers/:id` | Supplier detail |
| POST | `/api/admin/suppliers` | Created supplier (201; super_admin only) |
| PATCH | `/api/admin/suppliers/:id` | Updated supplier (super_admin only) |
| GET | `/api/admin/scripts` | Paginated scoped metadata; no bodies |
| GET | `/api/admin/scripts/:id` | Scoped detail including editable body |
| POST | `/api/admin/scripts` | Created scoped record (201) |
| PATCH | `/api/admin/scripts/:id` | Updated scoped record |

List envelope: `{items, page, hasMore, canWrite}`. Fixed page size 50, `page`
1–1000000. Script lists accept optional `entityId` UUID; suppliers are global
and reject an entity filter. Ordering is name then UUID. There is no server search.

Supplier input: required `name` (150 characters), optional `contactInfo` (4000).
Script input: required `entityId` (UUID), `name` (150, application/script name),
`type` (`sh` or `sls`), `os` (platform values above), `body` (48000 characters,
nonblank), optional `description` (4000). Body whitespace is preserved exactly.
Other strings are trimmed. All response fields are explicit; creator identities,
credentials, connection strings and internal database errors are not returned.
Authorized script detail/write responses necessarily contain the stored body.

PATCH is sparse; optional fields accept null or blank to clear. Required fields
cannot be cleared. Empty PATCH, unknown/case-folded/duplicate keys, invalid UTF-8,
NUL, wrong types, trailing JSON and bodies over 256 KiB return 400. IDs, types,
platforms and lengths are validated before mutation SQL. Conflict/serialization/
deadlock errors return generic 409; missing references 400; internal errors 500.

Queries use request contexts with an 8-second deadline. Mutations, readback and
audit insertion share one serializable transaction; PATCH locks its scoped row.
Audit records store actor, entity (null for global suppliers), action, target ID
and changed field names only — **never script body or contact values**. Failed
audits/readback roll back the mutation. No automatic mutation retries are made.

## Validation and limitations

Go/sqlmock tests cover route roles, strict malformed payloads, create/edit
contracts, sparse updates, scoped SQL and delegated entities, missing IDs, audit
rollback and generic errors. React/Vitest mocks cover create/detail/edit/list,
read-only global suppliers, navigation/history, validation, denied responses,
aborted/late account responses, dirty-draft preservation and no execution calls.
Existing manual asset sparse-update tests remain in place.

Validation on 2026-09-19 in MAIN:

- Full offline Go suite passed; focused admin catalog/assets race tests passed.
- Full frontend suite: 25 files passed, 448 tests passed, one non-applicable
  supplier entity-filter case skipped (suppliers are global).
- Frontend app/node type checks, lint, and no-write Vite build passed.
- New Go files pass read-only gofmt checks.
- Vitest and Vite ran with `envDir: false`; Go used the absolute cached toolchain
  with `GOPROXY=off`, `GOTOOLCHAIN=local` and `-mod=readonly`.

These are offline mock tests, not live PostgreSQL integration or production UI
verification. Migration 042 must be reviewed/applied through the normal release
process before using script storage. No automatic import of executable scripts
is performed. Windows/PowerShell and multi-variant grouping are not added beyond
the existing library vocabulary. This is **not a secret vault or a secret
scanner**: operators are explicitly warned not to put credentials in bodies,
descriptions or contact information. Use runtime secret references in reviewed
scripts, never embedded secrets. No arbitrary command execution was introduced.