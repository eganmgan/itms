# Collector telemetry contract (prepared, not deployed)

This change is collector + ingestion + backend read telemetry only. No frontend,
application catalog/install API, live migration, installer execution or deployment
is included. Apply migration **043_inventory_telemetry.sql** before releasing this
backend. It creates `asset_inventory_telemetry`, widens package name/version text,
and adds a partial unique index for one unresolved `patch_inventory` alert per
asset. Existing migrations and manually managed metadata are unchanged.

## Ingest JSON (additive)

The existing `{ "assets": [...] }` / array envelope and authentication are unchanged.
Each asset can now contain `collection_status`, an object keyed by section:
`software`, `updates`, `hardware`, `network`, `remote_access`. Each section is:

```json
{
  "status": "success",
  "source": "dpkg,snap,flatpak",
  "scanned_at": "2026-09-19T10:00:00Z",
  "scope": "description of discovery coverage",
  "total": 1250,
  "returned": 1250,
  "truncated": false
}
```

- `status`: `success`, `partial`, `failed`, `unsupported`, or `uncollected`.
- `source`, `scanned_at`: strings; collectors report UTC RFC3339 time. Legacy
  snapshots are exposed as `uncollected`, source `legacy_or_uncollected`, with no
  claimed scan time.
- `scope`, `error`: optional strings. Errors are sanitized, not raw command output.
- `total`, `returned`: optional integers, describing discovered and emitted items.
- `truncated`: optional boolean (omitted means false).

Existing `compute_details` fields remain, with:

```json
{
  "pending_updates": 1,
  "pending_update_details": ["example/stable 2.0 amd64 [upgradable from: 1.0]"],
  "reboot_required": false
}
```

`pending_updates` is **integer or null**, not zero on failure. `reboot_required`
is **boolean or null** (unknown/not supported). `pending_update_details` is a
string array, derived from the same scan as the count. A successful empty scan
explicitly supplies `0` and `[]`. Only a successful, nontruncated scan with
count equal to list length is authoritative. On incomplete scans the collectors
send null count; partial lists may be emitted but cannot resolve patch alerts.
The current-attempt API list preserves bounded partial results (at most 5000),
but is empty for failed/uncollected scans; the previous
successful list/count remain in legacy compute storage for retention, not as
evidence of current cleanliness.

`installed_software` keeps the existing array of `name`, `version`, `install_date`
and `source` records. Empty/unknown dates are empty strings; Windows registry
dates are normalized to ISO dates. Discovery does not infer installation dates
from file modification times.

## Retention and reconciliation

- Successful software snapshot + array: replace stored software, including clear
  on explicit successful `[]`.
- Failed/uncollected/unsupported/omitted software: do not delete stored rows.
- Partial software: merge exact source/name/version observations, do not infer
  removal. A subsequent complete scan removes old versions/absent packages.
- Legacy nonempty arrays: merge-only (old collectors silently capped at 200).
  Legacy empty arrays do not prove removal. Legacy update zeros never prove clean.
- Successful updates create/update one unresolved `patch_inventory` summary in
  `asset_alerts`; successful zero without a reported pending reboot resolves that source only and records resolution
  time/MTTR. Failed, missing, partial, inconsistent and legacy scans cannot resolve.
- The scoped Patch alerts GET includes this source. Other alert sources and write
  permissions are unchanged. Old unresolved device alerts remain visible beyond
  the seven-day recent-resolved window.
- `inventory_changed` history records bounded status/count/system summaries and a
  fingerprint of meaningful state. Scan times, `last_seen`, and array ordering do
  not generate heartbeat history. Device history reads return the newest 200 rows.
- Upserts, software writes, telemetry, alert reconciliation and history are in the
  same transaction. The asset upsert serializes per-device writes; the partial
  unique alert index protects against duplicate open collector alerts.

## GET /api/devices/:id

Inventory-only; no Salt dependency. Existing hardware/network/apps remain, plus:

| JSON key | Type |
|---|---|
| `collectionStatus` | section map, same snake_case inner fields as ingestion |
| `pendingUpdates` | integer or null |
| `pendingUpdateDetails` | string array |
| `updateScanStatus` | section status string |
| `updateScannedAt` | UTC RFC3339 string or null |
| `rebootRequired` | boolean or null |

Unverified/legacy/failed scans expose `patchStatus: "unknown"` and
`complianceScore: null`; only authoritative successful scans use `pending` or
`up_to_date` (`reboot_required` for successful zero with a reported pending reboot).
Pending reboot keeps the collector patch alert open. This score remains the existing
heuristic, not a security assessment.
`installedApps` may contain retained older observations when the latest software
section is not successful. Consumers must show the status/coverage alongside it.
Hardware includes processor, memory, storage, GPU, display, BIOS, OS/build/kernel,
architecture, boot/seen timestamps, volumes, disk layout and numeric remote IDs.

Device alert/history readers allow the same super_admin/admin/it_team/employee/
auditor read roles and primary/delegated-entity or employee-assignment scope as
device detail. No patch/install/mutation permission has been broadened.

## Coverage and safety

- Python: native dpkg (including dependencies) or RPM, snap, flatpak, Homebrew
  (including standard absolute paths), known macOS `.app` roots, collector-user
  pip and global npm. Portable apps, offline/unloaded user profiles and every
  language environment are not promised.
- Windows: machine 32/64-bit uninstall registries, loaded user uninstall hives,
  all-user AppX. No user hives are loaded; no user documents/password stores are
  searched. Registry/AppX failure marks the scan partial. CIM network inventory
  includes enabled adapters, MACs, IPv4 addresses, gateway and DNS.
- Default software bound 5000, maximum 10000; exceeding it reports `partial`,
  `truncated`, `total`, and `returned`, never silent truncation.
- Updates run once: apt list, cached dnf/yum check-update (exit 100 accepted),
  macOS softwareupdate list, or Windows Update COM in an isolated job. Linux uses
  existing package metadata; success does not certify repository freshness.
  OS updates only: no claim of pending updates for every third-party app.
- Update timeout 120 seconds; native package commands 60 seconds; Windows
  software job 120 seconds; remote ID commands 10 seconds. These bound individual
  scans, not the complete collector plus existing optional security scanners.
- AnyDesk/RustDesk collection invokes installed executables with `--get-id`,
  including standard macOS/Windows paths; only numeric local IDs are accepted.
  No remote passwords, tokens or arbitrary configuration are harvested.
- macOS root volume metadata is collected through diskutil; hardware fields are
  best-effort and missing fields mark coverage partial. macOS installer selects a
  working Python from Homebrew Intel/Apple Silicon or Apple locations.
- Scheduled refreshes default to detailed inventory. Windows tasks read metadata
  as data from configuration instead of interpolating names into commands or
  passing PowerShell 5.1-incompatible boolean strings. Generated Windows commands
  download a unique temporary `.ps1`, invoke it, and clean up; `PSCommandPath`
  exists. Quotes are escaped and the short-lived enrollment exchange is preserved.

## Validation boundary

Tests use Python mocks and Go SQL/HTTP fixtures only. Windows checks are static
when PowerShell is unavailable. Actual Windows 5.1/WUA/AppX, macOS/launchd,
distribution package managers and live PostgreSQL migration behavior require
separate staging validation. No real endpoint was inventoried or upgraded.