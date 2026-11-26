# Manual computer administration API

## Device lifecycle editor (deployed 2026-10-12)

Deployed at 06:22 UTC from the verified production-based release
`lifecycle-20261012`, not from the unfinished main worktree. The previous live
device page had no lifecycle editor or lifecycle save endpoint. The release adds
authenticated GET/PATCH `/api/devices/:id/lifecycle` and **Edit asset details** on
the device page. GET returns canonical saved lifecycle fields and
`canEditLifecycle`; the UI reloads those values after a save. Employee/auditor
access remains read-only. Exact super admin can save repeatedly; IT team gets one
successful save per asset across all three sections and all IT team accounts.

The frozen release passed 1,045 frontend tests (two skipped), full backend tests,
frontend types/lint/build, eight built-bundle role/viewport checks, and a restored
database rehearsal with 30 authenticated API checks. Real concurrent IT requests
produced exactly one success and one conflict. Validation failure did not consume
the allowance; super admin edits did not reset it. All test saves were isolated
from production. Real signed-in user acceptance is still pending.

Fresh database/frontend/runtime backups and rollback metadata are retained in the
private `lifecycle-20261012` release directory. Live verification passed for 49
files, 11 routes, health and authentication guards. No migrations, database
container changes, account changes or production test records were introduced.
Runtime configuration, installers and business counts were preserved. Use this
release's `release.cjs verify` for current verification; the October 9 frontend
manifest is historical. Do not publish the unfinished main worktree.

### Initial local implementation (historical)

The device detail editor groups Management - Asset Lifecycle, Financial &
Administrative Information, and Warranty Information into one sparse save through
`PATCH /api/devices/:id/lifecycle`. Exact `super_admin` can save repeatedly;
`it_team` can save once per compute asset, shared across all IT team accounts and
all three sections. Existing entity access restrictions still apply.

An asset row lock serializes lifecycle saves. The successful IT save inserts
`it_team_lifecycle_saved` in `asset_history` in the same transaction. Validation or
transaction failures do not consume the allowance; super admin edits do not reset
it. No migration or historical backfill is included: previous saves without this
marker do not consume the new allowance. Keep this marker when retaining asset
history. General legacy computer writes use the existing administrator guard.

Device detail returns `canEditLifecycle`; successful saves return `ok` and the
remaining permission. The UI uses server permission, sends only changed fields,
and blocks blind retries after an uncertain save. Empty strings clear optional
values. Dates, decimal cost and warranty months are validated before writing.
Warranty expiry remains an explicitly entered value in this endpoint.

Local verification: eight frontend tests, isolated Go lifecycle policy/locking/
validation tests, scoped lint, and synthetic desktop/mobile browser checks pass.
Full API compilation is blocked by pre-existing missing role/connectivity helpers;
frontend typechecking is blocked by existing page/route prop mismatches. The legacy
guard route test could not run for that reason. This change is NOT deployed and
has not been tested against production data or a real concurrent database workload.

This API uses only `assets`, `asset_compute_details`, and `asset_history`. It does
not create or mirror `stock_items`. Apply the normal PostgreSQL migration process
before running this version: migration `041_admin_computer_management.sql` adds
the literal `admin` role, the department-backed `group_in_charge_id`, and the
`manually_managed` ownership flag. No migration is applied by API requests.

## Authorization

Every endpoint requires authentication and exactly `admin` or `super_admin`.
`admin` can access its primary entity and explicit `user_entity_access`
memberships; `super_admin` is global. Other roles, including `it_team`, cannot use
this API. Neither role is an alias for the other. Out-of-scope detail/patch targets
return 404; explicit out-of-scope entity selections return 403.

## Routes

| Method | Route | Result |
| --- | --- | --- |
| POST | `/api/admin/assets` | 201, created computer |
| GET | `/api/admin/assets` | `{items, total, page, pageSize}` |
| GET | `/api/admin/assets/options` | Named option arrays |
| GET | `/api/admin/assets/:id` | Computer |
| PATCH | `/api/admin/assets/:id` | Updated computer |

There is no DELETE endpoint in this contract. Use a status change to retire a
computer. Existing legacy asset deletion has an additional computer role guard.

List pagination defaults to `page=1&pageSize=50`; pageSize is 1–200 and page is
1–1000000. `assigned=false` selects unassigned computers, `assigned=true` assigned
computers; omission includes both. List and options accept `entityId` (or `entity`)
as a UUID filter. List returns only `is_compute = TRUE` rows, with no mandatory
assigned-user join, ordered by asset tag and UUID.

Options returns `entities`, `locations`, `departments`, `users`, `technicians`, and
`suppliers`, each an array of `{id, name}`. An entity selection narrows all
entity-owned options. Suppliers are global because the existing supplier schema
has no entity ownership. Users must be active; technicians must additionally have
literal `super_admin`, `admin`, or `it_team` role and belong to the selected entity.

## Payload and response

Only these exact, case-sensitive camelCase keys are accepted:

`entityId`, `assetTag`, `name`, `category`, `hostname`, `manufacturer`, `model`,
`serialNumber`, `locationId`, `deptId`, `assignedUserId`, `technicianInChargeId`,
`groupInChargeId`, `status`, `purchaseDate`, `supplierId`, `cost`,
`warrantyStartDate`, `warrantyDurationMonths`, `updateSources`, `osName`,
`architecture`, `notes`.

- POST requires `entityId`, `assetTag`, `name`, and `category`; `status` defaults to
  `in_use`. Category is the computer type. Category and status use bounded labels,
  not a newly introduced enum.
- PATCH is sparse: omitted fields are untouched. Optional fields accept explicit
  `null` (empty strings also clear optional string fields; duration requires an
  integer or null). Required fields, including status, cannot be cleared. Empty
  patches are rejected.
- `entityId` may change only within the actor's scope. Existing and supplied
  relationship IDs are validated against the resulting entity, so a transfer must
  replace or clear incompatible relationships. Group references departments.
- UUIDs must use the standard hyphenated representation. Related rows must exist;
  entities, locations, assigned users, and technicians must be active.
- `cost` is a nonnegative **decimal string**, never a JSON number: at most ten
  integer digits and two fractional digits, no exponent. It is returned as a
  two-decimal string without float conversion.
- Dates are exact `YYYY-MM-DD`, years 0001–9999. Duration is a JSON integer from
  0–1200 months. Warranty end is start plus duration, clamped to the final day of
  the destination month (2024-01-31 + 1 month = 2024-02-29). Derived dates beyond
  year 9999 are rejected. If either warranty input is cleared, end is cleared.
  An unrelated patch leaves a pre-existing warranty end unchanged.
- Bodies are limited to 64 KiB. Unknown, case-mismatched, duplicate, malformed,
  trailing JSON, invalid UTF-8, wrong-type, oversized and invalid-date fields
  return 400.

Computer responses contain all listed keys (null when unrecorded), plus `id`
(database UUID), `isCompute: true`, and `warrantyUntil`. Dates have no time suffix.
Clients cannot set `id`, `isCompute`, `warrantyUntil`, or agent identity. No Salt ID
is fabricated from a manual hostname.

Asset changes, OS changes, and history insertion use one serializable transaction.
PATCH locks the asset row. Unique-key and serialization/deadlock conflicts return
409; internal database failures return a generic 500 and roll back uncommitted
changes. Failed delegated-scope lookups also return a generic 500, never data or
a misleading authorization denial. Responses are read inside the transaction
before commit.

## Ownership and compatibility

Manual POST/PATCH marks a computer as manually managed. Both inventory-sync
update paths preserve its identity, entity, assignment, management, lifecycle,
notes and manual OS fields, including deliberately cleared values. Hardware,
software, network and update telemetry continue to ingest. Existing purchase,
warranty and status values also survive sync for records predating the flag.
The first compute-detail INSERT also preserves unrecorded manual OS values when
a legacy computer has no detail row. Sync accepts only explicitly reported Salt
IDs, does not infer them from hostnames, and leaves existing enrollment intact
when an incoming payload omits the ID.

Legacy canonical asset create/edit/delete/assign/unassign paths reject manual
computer mutations by `it_team`, including attempts to demote an existing computer
with `is_compute=false`. Non-compute inventory and unrelated IT operations retain
their existing authorization. Token-authenticated agent ingestion is unchanged.

Tests are offline Go/sqlmock contract tests, not live PostgreSQL integration tests.
