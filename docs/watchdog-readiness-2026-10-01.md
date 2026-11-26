# ITMS Watchdog and Deployment Readiness

Status: LOCAL IMPLEMENTATION ONLY. NOT READY FOR DEPLOYMENT.

No production publication, service restart, route/firewall change, migration,
endpoint operation, key acceptance, or automatic repair was performed for this work.

## Settings Watchdog

- Location: Settings -> ITMS watchdog (`/settings/watchdog`).
- API: authenticated `GET /api/admin/watchdog`, exact `super_admin` only,
  `Cache-Control: no-store`.
- Production startup starts one cancellable backend collector every 60 seconds.
  Each collection has a five-second shared context budget. Requests read the latest
  in-memory snapshot instead of starting fleet-wide probes.
- Database connection health, aggregate stale/unknown agent heartbeats and missing
  Salt identities, and up to 100 recent unresolved alert groups are reported.
- Alerts cover records created in the last 24 hours and link to the affected device
  or workspace. They are historical evidence, not proof a failure is still present.
- Salt, SSH, Wazuh, and inventory-ingest configuration presence is checked without
  returning configuration values. Configured integrations remain **Not verified**:
  no live endpoint command, network sweep, or credential test is performed.
- Backend HTTP 5xx responses on registered routes are grouped by HTTP method,
  route template, and status. Up to 50 groups are retained, expire after 24 hours
  without another occurrence, and are lost when the backend restarts. Request
  URLs, query strings, IDs, headers, bodies, and raw error text are not retained.
- A page error boundary prevents a rendering failure from blanking the main
  workspace. Settings shows up to 20 page-level summaries for the current browser
  account/session. These are not uploaded; exception messages and stacks are not
  stored. Browser reload clears them. This does not capture every event-handler,
  unhandled promise, browser network, header, or assistant error.
- Settings offers status/search filters, timestamps, manual refresh, and links.
  Frontend automatic refresh remains disabled. An eight-second watchdog request
  timeout, access-denial clearing, and stale-report warning prevent false success.
- `/settings/chat` now reaches the existing Chat Settings component. Direct UUID
  device URLs and supported tabs now reach the device page without a prior directory
  selection, including watchdog links to device alerts.

## Explicit Limits

This is an application watchdog, not an external uptime supervisor or an automatic
repair service. If the backend is stopped, the browser reports the request failure;
the stopped backend cannot collect checks or notify users independently. No email,
external alert delivery, service restart, package operation, or persistent incident
store was added. Existing recorded alerts retain their existing persistence.

Host disk/CPU/memory, browser pages in other sessions, every API business workflow,
and live integration connectivity are not certified by the report. A green database
check does not certify deployment readiness. The UI explicitly says deployment
readiness is not certified.

The previously investigated spare device still has unresolved server-to-device
SSH reachability and target-address/port configuration issues. This watchdog does
not repair VPN routing or SSH configuration.

## Verification Results

| Gate | Result |
| --- | --- |
| Focused watchdog Go tests with race detector | PASS |
| Focused Settings/watchdog/direct-route UI tests | PASS: 43 tests, 3 files |
| Scoped lint for changed frontend files | PASS |
| Editor diagnostics for new watchdog code | PASS |
| Watchdog SQL against live database schema | PASS, read-only transaction rolled back |
| Production Vite bundle, environment-file loading disabled | PASS, isolated output; not published |
| Synthetic browser desktop 1440x1000 and mobile 390x844 | PASS, no horizontal overflow; search, status filter, refresh checked |
| Full frontend tests | FAIL: 800 passed, 67 failed, 2 skipped; 39 files |
| Full frontend TypeScript build | FAIL: three existing device/App Services contract errors |
| Full backend tests | FAIL: existing Chat and Patch API contract tests |
| Production free disk space at inspection | BLOCKED: approximately 352 MB free, filesystem reported 100% used |
| Authenticated live page and integration acceptance | NOT VERIFIED for this implementation |

Production bundling alone does not override the failed type/test gates. The
synthetic preview blocks production APIs and all writes and is not live monitoring.

## Blocking Page and API Findings

- `frontend/src/pages/DeviceOverviewPage.tsx`: calls `AppsServicesPanel` with
  `assetId` and `servicesOnly`, but the current panel signature accepts neither.
  Deploying this mismatch risks showing a fleet-level panel instead of the intended
  device-specific view. Do not remove the arguments just to silence TypeScript.
- `frontend/src/pages/device-overview/useDeviceOverview.ts`: imports
  `EndpointAction`, which the current model does not export.
- `DeviceOverviewPage.test.tsx`: 36 failures, including missing Remote Shell controls.
- `PatchPage.layout.test.tsx`: 16 failures around package-command review, result
  reporting, and department readiness.
- `PatchPage.ssh.test.tsx`: 3 failures around endpoint status, search, and request
  ownership.
- `App.test.tsx`: 11 failures around assistant device context and navigation;
  `App.lazy.test.tsx`: 1 failure in cold-route navigation expectations.
- Backend failures include Chat assignment settings/authorization, claim/presence,
  support message membership/persistence, Patch package-management validation,
  exact ping response handling, and scoped department fallback.
- These broader inconsistencies were already present when their relevant code
  was inspected. They were not papered over by weakening tests or changing unrelated
  workflows. The first full frontend audit before the new page boundary/device-route
  change also had 67 failures.

## Release Requirements

1. Reconcile the listed page/component/API contracts and rerun the complete
   frontend TypeScript, frontend tests, and backend tests successfully.
2. Arrange adequate disk capacity without deleting required release/database backups.
3. Verify real signed-in workflows for each role and the supported device tabs,
   plus Salt/SSH/Wazuh and inventory operations on explicitly approved targets.
4. Review the complete dirty worktree and freeze an exact deployment candidate.
   The watchdog changes are not authorization to publish unrelated local changes.
5. Obtain explicit deployment approval; take fresh verified backups and preserve
   the active database environment, SSH overrides, and existing installer files.
6. Deploy backend and frontend together, verify the watchdog route with a real
   super-admin account, and observe two completed collection intervals.

No deployment candidate has been published or declared release-ready.