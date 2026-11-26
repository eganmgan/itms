# Apps & Services backend contract

Reviewed/hardened 2026-09-21. Source changes only: no migrations applied, deployment,
remote endpoint actions or live database validation performed. Frontend and collectors
are separate workstreams. This contract supersedes older install documentation for
HTTP 202 on unknown replay/ambiguous commit and verification of no-op installs.

## Authentication and scope

All routes below are authenticated under `/api`; responses use `Cache-Control: no-store`.
Role comparisons are literal, case-sensitive. Capability booleans describe role permission,
not provider availability, package eligibility or authorization for another device.

| Operation | Allowed roles |
| --- | --- |
| Read catalog, live manageable services, management history | `super_admin`, `it_team`, `admin`, `auditor` |
| Install/remove applications; service actions | `super_admin`, `it_team` |
| Create/edit catalog | `super_admin` only |
| Read software permissions, install history, recorded device inventory | Above readers plus `employee` (assigned devices only for device reads) |

Except `super_admin`, device access is constrained to the asset's primary/delegated
entity grants; a user assignment alone does not grant an operator cross-entity access.
Employee inventory/history readers use their existing assigned-device policy.
Catalog entries must be active, in the **device's** entity, and match its recorded OS
family (`linux`, `windows`, `macos`) for both install and remove. Unknown OS is rejected.
The supplied application UUID selects a server-side package ID; inventory display names
are never accepted as package-removal instructions.

## Routes and JSON

Dates are RFC3339 strings. UUIDs are strings; mutation request IDs and application IDs
must be nonzero UUIDs. Requests are strict JSON: no extra fields, duplicate keys,
case-folded keys, nulls, coercion, or trailing documents. `confirmed` must be boolean `true`.

### Catalog / permissions

- `GET /api/software/permissions` -> `200 {canManageCatalog:boolean, canInstall:boolean}`.
- `GET /api/software/catalog?entityId=<uuid>&os=<family>&active=true&page=1`
  -> `200 {items:Application[], capabilities:{canManageCatalog,canInstall}, page:number, hasMore:boolean}`.
  All filters are optional. Page size 50; entity filters cannot expand authorization.
- `POST /api/software/catalog`: required `{entityId,name,os,packageName}`;
  optional `{description,active}` (defaults empty string / true) -> `201 Application`.
- `PATCH /api/software/catalog/:id`: nonempty sparse selection of
  `{name,description,os,packageName,active}` -> `200 Application`. Entity is immutable.
- `Application` is exactly `{id,entityId,name,description,os,packageName,active,updatedAt}`.
  Only `active` is boolean; other fields are strings. No catalog deletion route.

### Install approved software (existing route, hardened outcomes)

`POST /api/assets/:id/software-install`

Request: `{requestId:<uuid>, applicationId:<catalog UUID>, confirmed:true}`.

Response: `{install:InstallRecord, replayed:boolean, outcomePersistenceUnconfirmed?:true}`.
HTTP **200** for `succeeded` or `failed`, **202** for `unknown`, including replay.
An ambiguous initial commit returns the unknown reservation and
`outcomePersistenceUnconfirmed:true`, without dispatch. The same flag also identifies
an unconfirmed final persistence attempt; never treat it as a safe retry invitation.

`InstallRecord` is exactly:
`{requestId,assetId,applicationId,applicationName,packageName,os,status,outcomeCode,createdAt,updatedAt,inventoryRefreshRequired}`.
All fields are strings except `inventoryRefreshRequired` (boolean, true only for success).

`GET /api/assets/:id/software-installs[?requestId=<uuid>]`
-> `200 {items:InstallRecord[], capabilities:{canManageCatalog,canInstall}}`.
Returns newest 50; the optional exact request filter is applied before that limit.
Empty, malformed or repeated `requestId` query parameters are rejected.

### Remove approved software / manage an observed service

`POST /api/assets/:id/management-actions`

- Remove request: `{requestId:<uuid>,kind:"software",action:"remove",applicationId:<catalog UUID>,confirmed:true}`.
- Service request: `{requestId:<uuid>,kind:"service",action:<action>,serviceName:<exact name>,confirmed:true}`.
- Service action is one of `start`, `stop`, `restart`, `enable`, `disable` only.
  No `remove`, `uninstall`, `delete`, `reload`, shell command, script, provider,
  version, target, source, executable path or service-definition mutation is accepted.
- Do not send `serviceName` for software, or `applicationId` for services, even empty.
- Request body limit: 4096 bytes.

Response: `{items:[ManagementRecord], capabilities:{canManage:boolean}}`.
HTTP **200** for `succeeded` or `failed`, **202** for `unknown`, including replay.

`ManagementRecord` is exactly
`{requestId,assetId,kind,action,status,outcomeCode,createdAt,updatedAt,applicationId?,serviceName?}`.
All fields are strings. Only the relevant application/service field is emitted.
No actor, entity, Salt target or raw provider output is exposed.

`GET /api/assets/:id/management-actions[?requestId=<uuid>]`
-> `200 {items:ManagementRecord[], capabilities:{canManage:boolean}}`.
Newest 100, ordered by creation descending then request UUID. Exact request filter
is applied before the limit. Empty, malformed or repeated filter is rejected.

### Live manageable service names (not service inventory)

`GET /api/assets/:id/services`
-> `200 {items:[{name:string,running:null,enabled:null}],status:<status>,capabilities:{canManage:boolean},error?:string}`.

- One read-only `service.get_all` call, no per-service state fan-out.
- `partial`: names available but running/enabled states not read (all nonempty lists).
  Error is `service states unavailable; names may be incomplete`.
- `success`: complete discovery yielded no supported names. This does **not** mean
  the operating system has no services: unsupported names/unit types are filtered out.
- `unavailable`: unmanaged/non-compute device, disabled provider, failed/malformed
  discovery. Items is `[]`, error is `service listing unavailable`.
- Names must match `^[A-Za-z0-9][A-Za-z0-9_.@:+-]{0,254}$`. Non-service systemd suffixes
  (`.target`, `.mount`, `.automount`, `.device`, `.socket`, `.timer`, `.path`, `.swap`,
  `.slice`, `.scope`) are excluded. Some valid OS names (e.g. Windows names containing
  `$`, spaces or escaped systemd names) are intentionally read-only in recorded inventory.
- Discovery is capped at 4096 raw entries and 2 MiB per response. A truncated discovery
  cannot authorize any action, even if the requested name appears before the limit.
- Every service POST performs its own fresh exact-name discovery before mutation.
  A previously rendered inventory row is not execution authority.

### Recorded inventory

`GET /api/devices/:id` retains its existing device-detail response, including:

- `installedApps`: recorded applications, not an approved executable package catalog.
- `services`: `[{name,display_name,state,start_mode,source}]` (all strings).
- `collectionStatus.services`: `{status,source,scanned_at,error?,scope?,total?,returned?,truncated?,truncated_count?}`.
  Status: `success | partial | failed | unsupported | uncollected`.
- `servicesLastSuccessAt` and `servicesUpdatedAt`: nullable RFC3339 timestamps.

Successful complete scans replace service snapshots (including explicit empty scans).
Partial scans merge observations without dropping unseen previous services. Failed,
unsupported or uncollected scans retain prior observations; omission leaves the snapshot
untouched. Therefore retained records can be stale: show collection status and timestamps.
Management does not synthesize inventory changes or automatically trigger collection.

## Outcomes, auditing and no-retry behavior

Every mutation reserves a request UUID with `status:"unknown"` /
`outcomeCode:"dispatch_unconfirmed"`, plus asset history and audit events, in one
transaction **before any Salt call**. Final outcome and both events are also transactional.
No audit/persistence success is fabricated. An unconfirmed final write returns the original
unknown reservation even if the remote operation might have succeeded.

Use one UUID per user-confirmed intent. Replaying the same route, actor, asset/entity
and payload returns its recorded result without dispatch; conflicts return 409.
UUID namespaces are separate for install versus management routes. After a lost response,
query the corresponding GET with that same UUID; never automatically generate a new UUID
or resubmit an operation. HTTP 202 is an uncertain outcome, **not** a queued job or a promise
of eventual completion. An unknown reservation may remain unknown indefinitely.

Only the stored exact minion ID is accepted, with `tgt:[id]`, `tgt_type:"list"`,
`expr_form:"list"`, `client:"local"`; configurable glob targeting is ignored. No host-name
fallback. No session-auth retries, redirects, async acknowledgements, raw output, or
arbitrary shell functions. Remote mutation runs at most once per durable reservation;
optional read-only discovery/verification is not a mutation retry.

| Operation/outcome | Status / outcomeCode |
| --- | --- |
| Verified install change map for requested package | `succeeded / package_changed` |
| Empty install map + nonempty `pkg.version` | `succeeded / already_present` |
| Verified removal change map for requested package | `succeeded / package_removed` |
| Empty removal map + empty `pkg.version` | `succeeded / package_absent` |
| Start/stop/enable/disable acknowledged true and matching boolean read | `succeeded / service_state_verified` |
| Restart acknowledged true | `succeeded / restart_acknowledged` (not proof of process health) |
| Explicit provider false / `ERROR:` mutation result | `failed / provider_failed` |
| Exact service name not discovered | `failed / service_not_found` |
| macOS install provider definitively absent | `failed / provider_unavailable` |
| Ambiguous response/verification/discovery | `unknown / response_unavailable`, `unrecognized_response`, `verification_unavailable`, `verification_mismatch`, or `service_validation_unavailable` |

An empty install map alone is no longer success. Read-only verification never promotes
malformed, multi-target, duplicate-key, oversized, trailing-JSON or non-200 Salt replies.
Salt/provider behavior remains platform-dependent; unsupported cases fail closed.

Removal and service stop/disable reject protected management/security component names
using a conservative case-insensitive substring denylist: `salt`, `wazuh`, `ossec`, `ssh`,
`inventory`, `itms`, `glpi`, `osquery`, `systemd`, `dbus`, `docker`, `containerd`.
Removal checks both catalog package ID and display name. This is not a dependency solver;
approved packages and their provider removal behavior still require administrative review.

Errors before a durable reservation use `{error:string}`: 400 invalid input/target,
401 unauthenticated, 403 role/protected component, 404 missing/out-of-scope asset or
same-entity catalog record, 409 conflicting request/inactive or OS-incompatible catalog,
503 unconfigured integration, 500 sanitized database failure. History GET can also return
500 for recording/schema availability errors. No automatic retry is safe based on HTTP
error alone; resolve an ambiguous request ID first.

## Migration and operational prerequisites

The existing migration runner sorts and transactionally applies migration files by name;
no separate route/migration registration is needed. Required schema additions are
043 (general telemetry), 044 (catalog/install requests), 045 (service inventory), and
046 (management requests). Route registration chains through `registerSoftwareRoutes`
inside the authenticated router. Migrations and real Salt provider behavior were reviewed
but not executed against live systems during this backend-only task.

Deliberate limitations: no service-definition uninstall; no arbitrary package IDs;
no automatic retry/reconciliation of unknown actions; no package version pinning;
no guarantees about dependency-side effects; no synchronous inventory refresh;
no production OS/provider compatibility claim from mocked tests alone.