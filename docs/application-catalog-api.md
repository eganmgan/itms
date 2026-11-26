# Application catalog and device package installation API

Implemented in MAIN on 2026-09-19. **Backend only; not deployed.** No live package installations, database migrations, container operations, environment-file changes, frontend changes, or Git operations were performed. Existing telemetry migration 043 and [inventory-telemetry-contract.md](inventory-telemetry-contract.md) were not edited.

## Ownership and migration

Migration number 044 was verified unused before adding [044_application_catalog.sql](../backend/db/postgres_migrations/044_application_catalog.sql). Apply it through the existing migration process during a separately authorized release, after 043. No packages are seeded, pushed, downloaded, or installed by the migration or by catalog authoring.

This is a **canonical package allowlist**, not an executable-script library. It does not reference `admin_installation_scripts`, `scripts`, `script_variants`, Salt BFF identities, or frontend-supplied roles. One catalog row describes one package on one OS in one entity. There is no variants array, custom manager, script body, SLS, command, URL, version, repository, provider override, or arbitrary Salt function input.

Implementation:

- [software_catalog.go](../backend/internal/api/software_catalog.go): routes, capabilities, strict input, scoped catalog listing/authoring.
- [software_install.go](../backend/internal/api/software_install.go): asset authorization, durable idempotency, installation history and outcomes.
- [packages.go](../backend/internal/integrations/saltstack/packages.go): constrained Go Salt client methods and result interpretation.
- [router.go](../backend/internal/api/router.go): registers the routes inside the existing authenticated group.

## Authentication and scope

All endpoints require the existing Go backend Bearer authentication. All responses set `Cache-Control: no-store`. Role names are exact, case-sensitive; aliases do not grant permission.

| Role | Permissions endpoint | Read catalog | Author catalog | Install | Read device install history |
|---|---|---|---|---|---|
| `super_admin` | Yes | All entities | Yes | All entities | All devices |
| `it_team` | Yes | Primary/delegated entities | No | Primary/delegated entities | Primary/delegated entities |
| `admin` | Yes | Primary/delegated entities | No | **No** | Primary/delegated entities |
| `auditor` | Yes | Primary/delegated entities | No | No | Primary/delegated entities |
| `employee` | Yes, both flags false | No | No | No | Assigned device only |
| Other/unknown role | No | No | No | No | No |

The install role allowlist matches existing asset execution endpoints: `super_admin` and `it_team`, **not ordinary `admin`**. Catalog/install SQL reuses `adminEntityPredicate`, including `user_entity_access`; history reuses `fetchAssetContext` and `deviceDetailAllowed`. SQL errors fail closed. An entity filter never widens scope. Out-of-scope catalog filters return an empty page; an out-of-scope asset or unavailable same-entity application returns 404.

Capabilities indicate role authorization, not Salt availability, per-device eligibility, or successful installation. The server rechecks authorization on every call. History additionally matches the asset's current entity to the request's entity snapshot, preventing disclosure of previous-entity installation records after an asset transfer.

## Endpoints and exact JSON contracts

### `GET /api/software/permissions`

Returns HTTP 200:

```json
{"canManageCatalog":true,"canInstall":true}
```

`canManageCatalog` is true only for `super_admin`; `canInstall` is true only for `super_admin`/`it_team`.

### `GET /api/software/catalog`

Optional filters: `entityId` (UUID), `os` (`linux`, `windows`, `macos`), `active` (`true` or `false`), `page` (integer 1–1000000, default 1). The default includes inactive entries, so installation selection should request `active=true` and the device's `entityId` and OS. Page size is fixed at 50, ordered by name then ID; `hasMore` indicates another page. There is no total count or free-text search.

Returns HTTP 200:

```json
{
  "items": [
    {
      "id": "50000000-0000-0000-0000-000000000005",
      "entityId": "10000000-0000-0000-0000-000000000001",
      "name": "Firefox",
      "description": "Approved browser",
      "os": "linux",
      "packageName": "firefox",
      "active": true,
      "updatedAt": "2026-09-19T09:00:00Z"
    }
  ],
  "capabilities": {"canManageCatalog": true, "canInstall": true},
  "page": 1,
  "hasMore": false
}
```

### `POST /api/software/catalog`

Super-admin only. Required strings: `entityId`, `name`, `os`, `packageName`. Optional: `description` (default empty string), `active` (boolean, default true). Selected entity must exist and be active.

```json
{
  "entityId": "10000000-0000-0000-0000-000000000001",
  "name": "Firefox",
  "description": "Approved browser",
  "os": "linux",
  "packageName": "firefox",
  "active": true
}
```

HTTP 201 returns the catalog item directly, with the same fields as a list item. No Salt call occurs. The standard audit middleware records `application_catalog_changed` with the catalog entity and safe item fields.

### `PATCH /api/software/catalog/:id`

Super-admin only. Sparse update of `name`, `description`, `os`, `packageName`, `active`; at least one field required. `id` is server-owned and **`entityId` is immutable**, even when the same value is supplied. Create a separate row for another entity. Clear description with `"description":""`; deactivate with `"active":false`. Nulls are not accepted. Returns HTTP 200 with the full updated item directly. No delete endpoint; deactivate instead. Existing install records retain their original package/name/OS snapshots.

### Common request validation

- Body limit 16 KiB; UTF-8 JSON object only.
- Exact camelCase keys; no duplicate/unknown/case-folded keys, coercion, null values, or trailing JSON.
- `name`: trimmed, nonblank, at most 150 Unicode characters.
- `description`: at most 4000 Unicode characters; empty allowed.
- `os`: exactly `linux`, `windows`, or `macos`.
- `packageName`: exactly the ASCII expression `^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$` (1–200 bytes). No leading option marker, spaces, wildcards, shell metacharacters, slashes, colons, equals signs, commas, URLs, architecture suffixes, or version syntax. No implicit trimming or provider-specific free-form syntax.
- Body UUIDs use the standard 8-4-4-4-12 hexadecimal shape, are normalized to lowercase, and must not be all zero. No UUID-version restriction.
- NUL characters are forbidden. Catalog ID/asset path IDs and UUID filters are validated before database casts.

### `POST /api/assets/:id/software-install`

```json
{
  "applicationId": "50000000-0000-0000-0000-000000000005",
  "confirmed": true,
  "requestId": "60000000-0000-0000-0000-000000000006"
}
```

The caller must confirm explicitly. Generate a request UUID once per intentional action and **retain/reuse it across HTTP retries, reconnects, and status checks**. Do not generate another UUID automatically on an error or unknown result.

Before reserving a new action, the server requires:

1. The existing execution role and primary/delegated asset scope.
2. A compute asset with a stored canonical `salt_minion_id`; **no hostname fallback**. Target syntax is `^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$`. No globs, compound selectors, commas, whitespace, or arbitrary target input.
3. An active catalog row in exactly the asset's entity, with a validated package identifier and compatible recorded OS.
4. A configured existing Go Salt integration.

Recognized OS families are Windows/Microsoft Windows; macOS/Mac OS/Mac OS X/Darwin; Linux/Ubuntu/Debian/Rocky/AlmaLinux/CentOS/Red Hat Enterprise Linux/RHEL/Fedora/Arch Linux/openSUSE/SUSE Linux Enterprise/Linux Mint/Oracle Linux. Matching is case-insensitive with explicit name boundaries. Unknown or absent recorded OS is rejected, not guessed to be Linux. The canonical recorded asset/minion mapping remains a trusted administrative input; this API does not perform remote identity enrollment or OS discovery.

Returns an envelope, **not** an updated software inventory:

```json
{
  "install": {
    "requestId": "60000000-0000-0000-0000-000000000006",
    "assetId": "30000000-0000-0000-0000-000000000003",
    "applicationId": "50000000-0000-0000-0000-000000000005",
    "applicationName": "Firefox",
    "packageName": "firefox",
    "os": "linux",
    "status": "succeeded",
    "outcomeCode": "package_changed",
    "createdAt": "2026-09-19T09:00:00Z",
    "updatedAt": "2026-09-19T09:00:02Z",
    "inventoryRefreshRequired": true
  },
  "replayed": false
}
```

`install` always has exactly these public fields. No actor ID, minion ID, credentials, infrastructure address, raw Salt result, raw command, or provider diagnostic is exposed.

### `GET /api/assets/:id/software-installs`

Scoped read-only status/history endpoint, including assigned-device employee access. Optional `requestId` UUID narrows to one action. Returns HTTP 200 with `{ "items": [<install record>], "capabilities": { "canManageCatalog": false, "canInstall": true } }`. Items use the same record shape above, newest first by creation time then request ID, maximum 50; no offset pagination. An absent matching request gives `items: []` after asset authorization. This endpoint makes **no Salt call**.

## Dispatch, outcomes, and durable idempotency

1. In an 8-second database transaction, lock the asset and selected catalog row for a stable authorization/package snapshot. Check for a previous request before catalog eligibility/provider availability, allowing a safe replay after deactivation or a provider outage.
2. Reserve `request_id` using `INSERT ... ON CONFLICT DO NOTHING`. Its global primary key binds actor, asset, application and entity snapshot. Any conflicting binding returns generic 409 without exposing the original request.
3. Commit the immutable snapshot, `status=unknown`, `outcomeCode=dispatch_unconfirmed`, an asset-history event and audit event **before** any remote operation. Failure or ambiguous commit means no dispatch. A concurrent losing request reads the persisted record and never dispatches.
4. Dispatch at most once from the winning transaction. The HTTP operation uses the existing Go Salt client's credentials, not Salt BFF identity. The payload is `client=local`, `fun=pkg.install`, `tgt=[exact-minion-id]`, `expr_form=list`, `tgt_type=list`, `arg=[packageName]`, `timeout=20`. Inline eauth or the existing static token is used; this path cannot enter the session-token replay branch. HTTP 401 does not retry installation.
5. Each Salt HTTP call is bounded to 25 seconds; the provider preflight plus install share a 30-second request-bound context. Client disconnection may cancel the call, but cannot prove the remote operation did not occur.
6. Persist the final result plus outcome audit/history in a fresh 8-second database transaction, even if the caller disconnected. No remote operation is retried if recording fails.

There is **no queue worker, automatic retry, automatic reconciliation job, or asynchronous job ID**. A crashed process may leave an unknown reservation that was never dispatched or an operation that completed remotely. This is deliberately conservative: exactly-once execution across a remote system cannot be guaranteed. A saved request ID prevents retry dispatches; it does not establish that installation occurred. Authorization/catalog edits after reservation do not alter the already-approved snapshot.

| Status / code | Meaning |
|---|---|
| `unknown` / `dispatch_unconfirmed` | Durable reservation exists; dispatch/completion is not confirmed, possibly still in progress or interrupted. |
| `succeeded` / `package_changed` | Exact-minion synchronous `pkg.install` returned standard old/new version changes including the requested package, with nonempty new versions. |
| `succeeded` / `already_present` | Exact-minion synchronous `pkg.install` returned `{}`, the documented no-change/already-present result. |
| `failed` / `provider_failed` | Exact-minion result was boolean false or an explicit `ERROR:` provider error. Diagnostics are discarded. |
| `failed` / `provider_unavailable` | macOS read-only preflight returned no `pkg.install`; installation was not dispatched. |
| `unknown` / `response_unavailable` | HTTP/auth/timeout/cancellation/decoding error or ambiguous/missing/wrong-target response envelope; completion cannot be established. |
| `unknown` / `unrecognized_response` | An exact-minion value exists but is not an accepted package result; includes arbitrary strings, true/null, async acknowledgements, malformed change records, and provider-specific nonstandard shapes. |

The Salt helper also returns `failed/invalid_package_target` for an invalid internal call; HTTP preflight rejects those inputs before a request is reserved. No fallback to a different responding minion is allowed. A response must contain exactly one return map with exactly the requested minion.

Fresh known outcomes (`succeeded` or `failed`) return HTTP 200; a fresh unknown outcome returns HTTP 202. **202 does not mean queued or installed.** Matching persisted replays return HTTP 200 with `replayed:true`, regardless of stored status; always inspect `install.status`. A failed/ambiguous final persistence operation returns HTTP 202 with the original unknown reservation and `outcomePersistenceUnconfirmed:true`. This flag does not imply a worker will retry; query the scoped history endpoint, which may show a committed outcome if the commit acknowledgment was lost.

Unknown results require inventory/operator reconciliation, not a new automatic request. A separately confirmed new attempt with a new UUID is a new operation, not a retry guarantee.

## Platform/provider and inventory behavior

- **Linux:** uses the configured Salt `pkg` provider and its approved repositories.
- **Windows:** uses Salt's configured Windows `pkg` provider and approved winrepo package IDs/manifests, not an arbitrary installer URL, shell, or automatic Chocolatey bootstrap. Administrators must manage/trust those repositories separately.
- **macOS:** before installation, make a read-only, exact-target `sys.list_functions` call with `arg=["pkg"]`; require `pkg.install` in the returned function list. A configured provider such as Homebrew/MacPorts is a prerequisite. The API does not configure/bootstrap the provider. Availability is not a guarantee a particular package/provider combination will succeed; nonstandard result shapes stay unknown.

No automatic inventory refresh is invoked here: existing refresh uses configured Salt states and is a separate authorization/execution path, not the restricted package operation. `inventoryRefreshRequired:true` is returned only for persisted successful outcomes. The UI should then offer/use its **existing authorized inventory refresh** (`POST /api/assets/:id/script` with `{"script":"refresh-inventory"}`), where that existing workflow is approved, and reload recorded inventory/telemetry. Read-only users must not attempt that execution route. Unknown operations may also need an explicitly authorized refresh for reconciliation even though the success-only flag is false.

Do not synthesize an installed application row in the UI from the catalog or dispatch response. Actual recorded inventory remains the source of installed package/version data. Display provider-reported success separately from refreshed inventory. Catalog creation/activation alone never dispatches anything.

## Database schema

Both tables are new in migration 044; no existing table or telemetry field is altered.

`application_catalog`:

| Column | Type / constraint |
|---|---|
| `id` | UUID primary key, default `gen_random_uuid()` |
| `entity_id` | UUID, required FK `entities(id)` |
| `name` | VARCHAR(150), required nonblank |
| `description` | VARCHAR(4000), required, default empty |
| `os` | TEXT, required enum `linux/windows/macos` |
| `package_name` | VARCHAR(200), required, same ASCII regex as API |
| `active` | BOOLEAN required, default true |
| `created_by` | UUID required FK `users(id)` |
| `created_at`, `updated_at` | TIMESTAMPTZ required, default `NOW()` |

Unique constraint `(entity_id, os, package_name)` applies to active and inactive rows. Listing index `(entity_id, name, id)`.

`software_install_requests`:

| Column | Type / constraint |
|---|---|
| `request_id` | Client UUID, global primary key (idempotency key) |
| `asset_id`, `application_id`, `entity_id`, `actor_id` | Required UUID FKs to assets, application_catalog, entities, users respectively |
| `application_name` | VARCHAR(150), required immutable snapshot |
| `package_name` | VARCHAR(200), required immutable snapshot |
| `os` | TEXT required enum `linux/windows/macos`, immutable snapshot |
| `status` | TEXT required enum `succeeded/failed/unknown`, default unknown |
| `outcome_code` | TEXT required, default dispatch_unconfirmed; API writes only the codes above |
| `created_at`, `updated_at` | TIMESTAMPTZ required, default NOW(); updated on outcome persistence |

Recent-history index `(asset_id, created_at DESC, request_id)`. No cascading deletion of install requests: do not purge idempotency rows while clients can retry them. There is no automated retention job. Existing `asset_history` and `audit_log` receive `software_install_requested` and `software_install_outcome` events in the same transactions as their corresponding record state, using only request/application IDs and status/outcome codes. They do not call an unknown reservation “installed.”

## Error behavior

401 unauthenticated/invalid token; 403 denied role; 400 invalid input, ineligible/noncompute/no-exact-target asset, missing/inactive entity on authoring, or invalid relationship; 404 absent/out-of-scope asset or same-entity catalog record; 409 inactive/incompatible application, conflicting catalog unique key/concurrent change, or request-ID binding conflict; 503 unconfigured Salt before reservation; 500 generic database/persistence error before dispatch. Remote failures after reservation use the outcome envelope rather than leaking provider diagnostics. No environment values, SQL errors, credentials, command output, or infrastructure addresses are returned.

## Frontend handoff

1. Settings manual application entry: show authoring only when `canManageCatalog`; choose an active entity on creation; use the catalog fields above. Existing script storage is not part of this UI/API.
2. Device Applications: show install controls only for `canInstall`; fetch active catalog rows for the device's entity and recognized OS, following pagination. Server validation remains authoritative.
3. Present application/package/OS/entity for explicit confirmation, then retain one UUID for that action. Send only `applicationId`, `confirmed:true`, `requestId` to the asset-specific route.
4. Display `succeeded`, `failed`, or `unknown` honestly. Do not label an HTTP 200/202 response “queued” or “installed” based only on status code.
5. Query `/software-installs?requestId=...` after connection loss and for recent history. Never automatically send a new UUID for an unknown result. There is no requirement to poll forever; there may be no later result after a crash.
6. On persisted success, refresh inventory through the existing authorized workflow; do not invent inventory rows. Keep late responses/account switches scoped to the current authenticated device view.

## Verification — exact results

Cached Go **1.25.0**, `GOPROXY=off`, `GOTOOLCHAIN=local`, `-mod=readonly`, `-count=1`; no dependency downloads. The full requested suite was run from MAIN with `go -C backend test -mod=readonly -count=1 ./...` (absolute backend path/cached binary in execution). A second full run with `-json` counted test events. Focused race verification used `-race -json ./internal/api ./internal/integrations/saltstack -run 'TestSoftware|TestPackage|TestInstallPackage'` with the same offline/module flags.

| Verification | Exact outcome |
|---|---|
| Full suite | **413 top-level tests passed**, 0 failed, 0 skipped |
| Full suite including named subtests | **1140 pass events**: 413 top-level + 727 subtests; 0 fail/skip events |
| Packages | **9 tested packages passed**; 8 packages have no test files; 0 failed |
| New focused coverage | **18 top-level tests**, **162 pass events** including 144 subtests; 0 failed/skipped |
| Focused race run | **162 pass events**, both API and Salt packages passed; no race reports |

Focused tests are in [software_catalog_test.go](../backend/internal/api/software_catalog_test.go) and [packages_test.go](../backend/internal/integrations/saltstack/packages_test.go). Coverage includes real-router auth/role matrices and audit, exact capabilities, primary/delegated scope predicates, assignment-only employee history, catalog authoring and sparse deactivation, invalid/immutable fields, package/target injection rejection, incompatible OS, unavailable providers, cross-entity catalog denial, durable replay and mismatched keys, concurrent conflict-loser behavior, reservation/history/commit/final-persistence failure paths, provider success/failure/unknown, macOS preflight, HTTP 401 no-retry in both authentication modes, missing/wrong/ambiguous minion responses, cancellation, and secret-safe responses.

Tests use `sqlmock` and loopback `httptest` servers. PostgreSQL migration application, real database lock/uniqueness contention, configured repository/provider behavior on real devices, deployment, and browser/UI integration **were not exercised**. No claim of live installation or release readiness is made.