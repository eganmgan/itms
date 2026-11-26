# Agent inventory coverage and heartbeat status

## ITMS empty app list investigation - September 30, 2026

Read-only checks for itms / ITMS-B24CD81C found 1,028 recorded packages:
1,020 dpkg, two dpkg_desktop, two npm and four snap. The only desktop-classified
entries are info and vim-common, both intentionally excluded system utilities.
Software collection succeeded at 06:31:37 UTC. An empty Apps table therefore
matches the recorded inventory and current filter; it does not establish that
the agent is outdated or that installed third-party applications are missing.

A fresh live service.get_all request for itms succeeded with 371 service names.
ListManagedServices deliberately returns unknown running/enabled states and a
partial status for nonempty listings; it does not query each service's state.
Separately, 256 recorded services have states from the 06:31:39 UTC inventory.
Those recorded states must not be represented as current live observations.

The misleading unconditional agent-update message was corrected to
"No matching desktop apps in the recorded inventory." The 105 panel tests,
frontend typecheck, scoped lint and editor checks passed. This wording correction
was deployed with user approval at 09:50 UTC. The production build and all 43
served frontend files plus both Apps aliases passed verification. Backend and
database container identities/start times and installers are unchanged; no
restart or endpoint action was performed during publication. Frontend entry:
index-D7VYgI69.js. Private backup and publisher:
~/.local/state/itms/releases/apps-empty-state-20260930 (verify is read-only).

No filter, approval, service control, collector or production record changed;
the investigation's only endpoint request was read-only service discovery.
Authenticated UI verification remains pending. The live backend remains the
Pritunl release below; its earlier frontend-preservation manifest is historical
after this frontend-only publication.

## Pritunl vendor lookup - September 30, 2026 - deployed 09:19 UTC

The Pritunl fix uses the canonical pritunl/pritunl-client repository.
A fresh public HTTP check confirmed the old repository endpoint
returns 301, while the canonical endpoint returns 200 with stable release
1.4.4752.50. Redirect rejection remains enabled. The vendor regression tests
and full offline backend suite passed; affected files have no editor errors.

Comparison with the apps-tickets release source manifest found only
software_versions.go and software_versions_test.go changed. Service-name
filtering already matches that release and is not an unpublished fix for the
reported live service failure. Focused service tests pass, but the live failure
has not been reproduced in this follow-up; no authenticated browser is shared.

The user approved a backend-only deployment. Private release and verified
database/configuration backups: ~/.local/state/itms/releases/pritunl-20260930.
The running image is backend-backend:release-pritunl-20260930. Only the backend
container was recreated; its environment, including the private database
configuration and SSH override, was preserved. Database identity/start time,
migrations, business-record counts, frontend files and installers are unchanged.
All 43 frontend files and both Apps aliases passed HTTP hash verification;
direct/proxied backend health passed and the vendor route still rejects
unauthenticated requests. The canonical feed returned 1.4.4752.50 from inside
the new backend container. No approvals or endpoint actions were performed.

Signed-in UI verification remains pending because no browser page is shared.
The unavailable live service lookup remains unresolved and was not part of this
deployment. Rollback uses the apps-tickets-20260930 backend image/compose override
with the connection-fixes-20260930/compose.ssh.json override retained; do not run
the old release publisher. The new release helper has a read-only verify stage.

## System apps, vendor versions and tickets - September 30, 2026 - 08:44 UTC

This release supersedes the apps-only layout below. Both Apps URLs are titled
Apps & Services and show a system table with hostname, asset ID and assigned
employee email. Clicking Apps opens that system's desktop app names, current
versions, latest vendor versions and approval ticket numbers. Live service
controls and recorded services are restored; scripts and inventory diagnostics
remain hidden in this view.

Latest versions use fixed official Chrome/Mozilla endpoints and vendor-owned
GitHub release feeds for NetBird, ONLYOFFICE, Pritunl and RustDesk. Only stable
numeric releases are accepted. Reads are bounded, redirect-free and cached;
unsupported apps or failed feeds show Unavailable. Vendor versions are not a
claim of OS compatibility or package-repository availability. No endpoint
commands run for these lookups.

Install/remove now requires both catalog approval and an unused ticket approval.
A super administrator explicitly approves an existing software/Software Access
ticket for one asset, catalog package and install/remove action. The ticket must
belong to the assigned employee in the asset's entity and must not be rejected
or cancelled. Pending/in-progress/resolved/approved ticket status alone grants
no permission: the separate explicit approval is required. The server consumes
the exact selected approval ID transactionally with the action reservation,
before dispatch. Status recovery and replay never consume another approval.
Used links retain the original ticket number and action request ID. Service
controls retain their existing authorization and protection rules.

Migration 052 adds software_ticket_approvals. Existing tickets/actions are not
backfilled or auto-approved. Production had only a pending enrollment ticket
and zero software approvals at deployment, so no valid software ticket was
available to use. No package approval, install, removal or service action was
performed during verification.

Private release/backup: ~/.local/state/itms/releases/apps-tickets-20260930.
Backend image: backend-backend:release-apps-tickets-20260930. Frontend entry:
index-FLxyrwfx.js. Deployment verified 43 frontend files and both Apps aliases,
backend health, unchanged private runtime environment/SSH override, unchanged
database container and original record counts, and unchanged installers. The
database received only the additive approval migration. Full backend tests,
132 focused frontend tests, typecheck, lint and production build passed. All
three approval queries were also prepared successfully by PostgreSQL.

After browser sign-in, authenticated desktop and 390px mobile inspection
confirmed the system/asset/email table and Apps expansion on it.spare. All six
desktop apps and the current/latest-version/ticket columns are visible. Five
vendor versions loaded; Pritunl reported Unavailable. All app rows showed No
linked approval and install/remove remained disabled. Recorded services were
visible, but the live service lookup returned service listing unavailable.
Neither result was replaced with guessed data. The page had no horizontal
overflow; wide tables scroll inside their containers on mobile. The browser
was restored to desktop with it.spare expanded. No approvals or endpoint
actions were performed, and no credentials or session tokens were accessed.

## Apps-only page - September 30, 2026 - 07:36 UTC

Both `/patch/apps` and `/patch/apps-services` now show the device selector,
desktop app names and versions, and approved install/remove controls. Patch
workspace tabs, script controls, live/recorded services, inventory diagnostics,
source metadata and routine action history are absent from these pages.
Service-list and script-catalog requests are skipped. Existing history reads
remain necessary for mutation safety; unknown outcomes still expose status
recovery and block new actions. Approval and confirmation remain required.

Frontend entry: `index-BmrqFE6P.js`. Private backup and deployment record:
`~/.local/state/itms/releases/apps-only-20260930`. Four source/test files changed
relative to the preceding release. All 43 frontend files and both Apps aliases
passed HTTP hash verification. Backend/database containers and installers were
unchanged; no endpoint software actions or catalog approvals were performed.

124 focused tests, typecheck, scoped lint and production build passed.
Authenticated desktop and mobile inspection showed the six previously verified
apps on it.spare, no unrelated panels, no page-level horizontal overflow and no
alerts. Install/remove remained disabled because the approval catalog had no
matching entries. Desktop filtering limitations below still apply.

## Live app-filter correction - September 30, 2026 - 07:28 UTC

Authenticated inspection confirmed that `/patch/apps` and `/patch/apps-services`
already served the same current release with no-cache headers. The remaining
problem was classification, not a stale URL: GNOME utilities, documentation,
editor support and a Canon printer-driver package had desktop registration.

The frontend now excludes the 13 confirmed Linux component identifiers from
both the recorded-app view and compatible catalog choices. Matching is exact
for dpkg/RPM sources, including Debian architecture suffixes; it is not a browser
allowlist, publisher inference or a claim of exhaustive OS-component detection.
Other independently detected desktop apps remain visible. Full device inventory,
catalog approval, permissions and endpoint action safeguards are unchanged.

Published frontend entry: `index-DJKPuCxg.js`. Private backup and deployment
record: `~/.local/state/itms/releases/apps-filter-20260930`. Exactly three source
files changed relative to the prior application candidate. All 43 files and both
Apps aliases passed HTTP hash checks; backend/database containers, installers and
endpoint tasks were unchanged. No package approval/install/remove was performed.

108 focused tests, typecheck, scoped lint, build and editor checks passed.
Authenticated verification on the exact `/patch/apps-services` URL showed six
apps on it.spare: Firefox, Chrome, NetBird, ONLYOFFICE, Pritunl and RustDesk.
The approved-package selector was empty and both mutation buttons disabled.
Rapid subsequent device switching hit HTTP 429, so the ITMS browser check was
not completed and no automated retry was made. System-level third-party
classification remains conservative and may need additional metadata for other
platform components; this correction covers the actual reported Linux entries.

## Live rollout - September 30, 2026 - desktop apps and Salt ping

This section supersedes the preparation-only notes below. Administrator
publication at 06:25:27 UTC was independently verified: all five installer and
collector downloads match the staged hashes on disk and over HTTP.

The matching backend/frontend release went live at 06:58:02 UTC:

- Backend image: `backend-backend:release-desktop-apps-20260930`.
- Frontend entry: `index-zrd7cVfy.js`; 43 served files and application routes
  hash-verified. Direct/proxied health checks passed with database up.
- Database container identity/start time, migrations, business record counts,
  runtime environment and the existing SSH port override were preserved.
- Private backups, frozen artifacts, deployment result and release helper:
  `~/.local/state/itms/releases/all-systems-20260930`.
- The active compose stack uses the base backend compose file, this release's
  `compose.release.yml`, and `connection-fixes-20260930/compose.ssh.json`.
  Keep the SSH override and existing private database configuration on recovery.

ITMS and it.spare collectors were upgraded after read-only preflight, with
root-owned backups at `/var/lib/itms/desktop-apps-20260930`. Their enrollment,
identity-preserving configuration and heartbeat schedules were unchanged.
A small service drop-in appends `--inventory-only`; existing six-hour timers
remain active. Both services completed with exit code 0. Latest verified data:
ITMS has 2 classified desktop apps out of 1,028 package records; it.spare has
19 out of 1,654, with a final inventory report at 07:13 UTC. Full package
inventories remain retained. No application installation/removal was executed.

A spare ClamAV job already running before the upgrade completed at 06:54 UTC
and uploaded its older 06:30 snapshot, temporarily replacing the new inventory.
After confirming that job had finished and uses the upgraded collector on future
runs, one explicit inventory-only refresh restored current observations. No
security task was disabled or rerun. The ingestion path still accepts delayed
older snapshots; monotonic snapshot handling remains a separate improvement.
Restarting the ITMS inventory timer also triggered an immediate additional
scheduled collection; both observed collections completed successfully.

The ThinkPad still failed the read-only Salt check and was not changed. Native
Windows/macOS installs and authenticated browser workflows remain unverified.
The existing missing `patch.baseline` state was not installed by this release.
Reload an existing browser tab manually to load the new UI; automatic refresh
was not reintroduced.

Release verification passed full Go tests, 131 focused frontend tests, TypeScript
and a fresh production build. A test-only readiness race was corrected by waiting
for Review to be enabled. Its hash amendment is recorded separately in
`test-readiness-amendment.json`; runtime artifacts were byte-identical. The
published installer candidate retains its original source manifest, so use
`publish-installers.cjs verify` for installed downloads and `release.cjs verify`
for the live application, rather than restaging or replaying publication.

## Desktop application view and Salt ping - September 30, 2026 - local only

The Patch console has an explicit `test.ping` mode. It uses the existing
authorized batch target lookup and Salt connectivity check, records history,
and does not execute `cmd.run` or `state.apply`. Shell/state arguments are
rejected on ping batch requests. Typing `test.ping` inside `cmd.run` remains
invalid. This does not deploy missing states such as `patch.baseline`.

Install / Remove Apps now displays classified desktop applications instead of
the complete package inventory. The full software inventory remains available
on the device. Classified records retain their provider in the existing source
field with a `_desktop` suffix; no schema migration is needed.

- Linux: visible Application desktop entries with executable metadata, excluding
  System/Settings categories; dpkg/RPM ownership or explicit Snap/Flatpak IDs.
  Known system application roots and current collector-user Flatpak exports
  are scanned. Package ownership queries share a 30-second budget.
- macOS: readable application bundles with a non-Apple bundle identifier outside
  `/System/Applications`. Apple bundles and unclassified Homebrew packages remain
  in the full inventory but not the desktop view.
- Windows: uninstall entries matching Start Menu executable targets, excluding
  system components, parented entries and updates; visible AppX registrations
  excluding frameworks, resources, nonremovable packages and system signatures.
  Existing job timeouts and bounded shortcut enumeration remain in effect.

This is conservative registration-based classification, not proof of publisher
identity. Missing/unreadable metadata, portable apps, unloaded user profiles and
some user-only installations may not appear. Old inventory remains unclassified
until the updated collector reports. An empty view is not proof of no apps.
Install/remove choices additionally require an active, entity/OS-compatible
catalog entry whose exact package identifier or display name matches a detected
desktop app. No package identifier is invented and detection grants no approval.
Apps not detected on this device are not offered in this view. Existing service,
script, confirmation, permission and unknown-outcome controls remain intact.

Validation: 131 focused frontend tests, 46 Python mock/static tests, full offline
Go tests, TypeScript, scoped lint, production build and editor checks passed.
PowerShell 7.4.20 parsed the collector and executed four isolated classification
checks. Native Windows/macOS collection and signed-in browser workflows have not
been verified. No deployment, endpoint scan, install/remove, or service restart
was performed for this change.

After the user's "proceed", the all-systems candidate was restaged with these
changes. The previous candidate and its staged files are preserved under a
timestamped `superseded-*` directory. The current five artifact hashes, eleven
expected backend/frontend source changes and all five live baseline downloads
passed the publisher's `check`. The helper now refuses publication when source
or installer files drift from this candidate. No publication record or backup
from a publication exists yet; production remains unchanged.

Publication is blocked by the root-owned installer directory. An administrator
must run the following directly, then the release can be independently verified:

```sh
sudo /usr/bin/node /home/itms/.local/state/itms/releases/all-systems-20260930/publish-installers.cjs publish
```

This publishes downloads only. Next, update authorized endpoints and obtain fresh
inventory, then release the matching backend/frontend while preserving the active
SSH override and database environment. Native platform pilots remain required.

## All-system enrollment - September 30, 2026 - prepared, publication pending

User requested the same setup for all existing and future systems. Linux/Fedora,
macOS and Windows installers now share explicit inventory-only initial/scheduled
runs, alongside their existing six-hour inventory and separate 30-second
heartbeat schedules. The new `--inventory-only` / `-InventoryOnly` collector
option prevents routine inventory from invoking security scans even when those
options are configured elsewhere; dedicated security scan tasks are retained.

Linux/Fedora and macOS generated commands already included SSH enrollment.
Windows now also accepts `-SshUser` and `-AuthorizedKey`, and its generated
command passes the server's existing public key for `itms-remote`. Windows
provisioning installs OpenSSH Server if needed, uses a non-admin account and
standard Users membership, restricts the managed key file ACL, requires public
key authentication for that account, and disables forwarding for that account.
New accounts use a randomly generated password that is neither logged nor
retained by the installer; SSH password authentication is disabled by the
managed per-user policy. Existing account credentials and listening ports are
preserved. Configuration is syntax/effective-policy checked before activation,
with a backup and restoration on failure. A new ITMS firewall rule is scoped
to the resolved server addresses; pre-existing firewall policy is not rewritten.
Custom SSH ports still require the matching backend host override; the installer
does not silently force port 22 or invent a server-side mapping.

macOS now fails enrollment clearly if account authorization or enabling Remote
Login fails, instead of reporting successful completion with unavailable SSH.
An administrator may need to grant Full Disk Access or enable Remote Login in
System Settings before retrying. Windows requires administrator execution and
access to its OpenSSH capability source; a required reboot is reported, not run.

Validation: 41 mocked collector/static installer tests, both Bash syntax checks,
PowerShell 7.4.20 parsing of both Windows scripts, six executable SSH input
validation cases, focused command-generation tests and the full offline Go
suite passed. The official user-local PowerShell runtime archive was checksum
verified. **Native Windows OpenSSH/account/firewall execution and native macOS
installation have not been tested here. Validate on representative devices
before broad endpoint rollout.**

The five matching installer/collector files are staged and checksum-pinned at
`~/.local/state/itms/releases/all-systems-20260930/staged-installers`. The helper
`publish-installers.cjs check` verified every staged hash and all five existing
live downloads. Publication requires an administrator because the live installer
directory is root-owned. No privilege bypass or sudo attempt was made.
The publisher backs up existing files, preserves their ownership/modes, publishes
collectors before installers, checks all HTTP downloads, and rolls back on
failure. Publication does not install agents or restart any service.

Release order:

1. Administrator publishes the staged files with the private helper's `publish`
  operation; independently verify with its `verify` operation.
2. Deploy the pending backend command-generation change only after installer
  verification. Preserve the current database environment and the
  `connection-fixes-20260930/compose.ssh.json` custom-port override. No frontend
  change or database migration is needed. Backend delta is one implementation
  file plus two test files; it is not yet deployed.
3. Preflight and update existing endpoints separately. Do not blindly rerun full
  installers or earlier one-off repair helpers. Their checksum pins refer to
  the previous collector and require fresh review after publication.

Existing ITMS and it.spare repairs from the previous section remain live. The
ThinkPad was checked again and still returned no usable management response;
no new endpoint changes were made during this preparation. No Windows or macOS
device was available for a native rollout in the registered fleet. Automatic
frontend refresh remains disabled.

## Connection fixes and endpoint repair - September 30, 2026 - deployed

User explicitly approved publishing the fixes and repairing SSH/inventory on all
three registered computers. Application publication completed at 04:30 UTC;
the verified per-device SSH configuration followed at 04:54 UTC.

- Backend: `backend-backend:release-connection-fixes-20260930`.
- Frontend entry: `assets/index-xZbzB8RL.js`; all 43 served files and the login,
  Apps and reported device routes were hash-verified.
- Full backend tests, 151 focused frontend tests, TypeScript, scoped lint and
  production builds passed. Direct/proxy health and database checks passed.
- PostgreSQL container identity/start time, migration history, business record
  counts and published installers were preserved. Backend restarted for the
  release and the separately verified SSH-only configuration change.

Endpoint results:

| Device | SSH | Inventory |
| --- | --- | --- |
| `ITMS-B24CD81C` | Existing SSH on port 22 retained; missing `itms-remote` account created with the existing public key, locked password, no sudo and forwarding restrictions | Missing collector/task installed; first scan succeeded; 256 services recorded |
| `ITSPARE-3F56D0EA` | Existing SSH, account and key were correct on port 8877; backend per-device override corrected the port without changing/restarting endpoint SSH | Old collector backed up and replaced; existing schedule retained; first scan succeeded; 318 services recorded |
| `ZERODHAADMI-8BF45CB3` | Salt management returned no usable response; no changes | Still blocked by reachability; no collector/task changes |

Both repaired endpoints now report successful software, service and update
collection. Hardware and network correctly remain Partial because provider
completion is best-effort. Both inventory services exited successfully and
their timers remain enabled/active. ITMS uses a new six-hour inventory schedule.
Existing heartbeat tasks were untouched and both endpoints continue reporting.
Protected inventory-only environment overrides preserve current asset metadata
and disable ClamAV, CVE and OpenSCAP report work in these inventory runs; no
separate security task was changed, no software updates were applied, and no
endpoint reboot occurred.

SSH authentication and the harmless `id -un` command passed for both repaired
endpoints from the server host and from the backend network namespace. These
checks enforced host keys obtained through the authenticated Salt channel;
they did not weaken the application's existing host-key configuration. Actual
signed-in browser workflows remain unverified because no page was shared.

Private release files and rollback backups are under
`~/.local/state/itms/releases/connection-fixes-20260930`. **Future backend
recreation must include both `compose.release.yml` and `compose.ssh.json` from
that directory in addition to the base backend compose file**, preserving the
existing database environment file. The JSON compose override supplies the
verified custom SSH port for it.spare. `release.cjs verify` recognizes this
recorded environment change. Endpoint inventory backups are root-protected at
`/var/lib/itms/repair-20260930/inventory`; original credentials were not changed.
Do not rerun repair mutations blindly: helpers deliberately refuse existing
repair files/accounts. App rollback must retain the SSH override and must not
roll back to a backend predating the separate heartbeat timestamp behavior.

Remaining action: restore ThinkPad management connectivity, then preflight it
before using its approved SSH/inventory repair scope. Reload the browser once
to load the published fixes and use manual Refresh for new inventory/status;
automatic frontend polling remains disabled.

## SSH and inventory diagnostics - September 30, 2026 - local fixes only

Recent nginx access-log 502 responses were for `POST /api/ssh/session`.
The sampled nginx error log contained no upstream connection refusal, timeout,
or premature-close entries, and the proxy health check returned 200. The SSH
handler itself returns 502 when its target TCP reachability check fails.
Read-only server-host TCP probes on the configured port 22 found:

- `ITSPARE-3F56D0EA`: recorded wired address refused the connection.
- `ZERODHAADMI-8BF45CB3`: recorded wired address refused the connection;
  recorded wireless address timed out.
- `ITMS-B24CD81C`: recorded wired address accepted the TCP connection.

These checks did not authenticate over SSH or execute endpoint commands. They
do not establish SSH authentication success or connectivity from the backend
container. No host overrides were configured. The resolver currently selects
the first stored candidate; alternative-address selection was not changed.

ITMS and it.spare had fresh heartbeats during this check; ThinkPad had none.
All three stored telemetry records marked software and updates uncollected and
had no service inventory record. Heartbeat receipt does not collect inventory,
and publishing a collector does not upgrade or run an existing endpoint task.

Local changes remove the unconditional Apps & Services deployment warning,
preserve JSON backend errors on the device page with a generic fallback for
non-JSON proxy responses, and explain why `test.ping` cannot be used as a
`cmd.run` shell command. Action permission checks and the command allowlist
remain intact. Frontend polling remains disabled.

Validation: 104 Apps & Services/navigation tests, 47 device-detail tests,
focused Go terminal-policy tests, frontend TypeScript and scoped lint passed.
These changes are not deployed. Endpoint SSH configuration, inventory-task
updates and scans remain pending authorization; no services were restarted.

## Manual status refresh - September 29, 2026 - deployed 12:27 UTC

At the user's request, automatic frontend connectivity refresh was removed from
both Devices and device details. Initial page/account loading and explicit Refresh
still retrieve backend status; timers, focus and visibility changes no longer
trigger reads. Device actions retain their completion refresh. Displayed status
is a snapshot with a backend check timestamp, not a continuously updated view.
Endpoint heartbeat timers and backend status calculations continue unchanged.

User approved frontend-only publication at `2026-09-29T12:27:06.358Z`.
Entry: `assets/index-DoWjL80Q.js`. All 43 served files, login and the reported device
URL matched the new artifact. Backend/PostgreSQL containers, installers and
endpoint tasks were unchanged. Backups, source manifest and publication result:
`~/.local/state/itms/releases/manual-status-refresh-20260929`.
All 96 affected-page tests, TypeScript, scoped lint and production build passed.
Authenticated browser verification remains pending user sign-in. The earlier
15-second polling descriptions below are historical and superseded by this change.

## Backend presence response - September 29, 2026 - deployed 11:37 UTC

User approved backend/frontend deployment. Release
`backend-backend:release-backend-presence-20260929` went live at
`2026-09-29T11:37:40.688Z`; frontend entry is `assets/index-B3Q1738V.js`.
All 43 served frontend files and login HTML matched the candidate byte-for-byte.
Backend health and database health passed directly and through nginx; the new
presence read still rejects unauthenticated requests with 401. Effective backend
environment, PostgreSQL identity/start time, migration history, business counts,
published installers and endpoint tasks were preserved. No database migration.
Private backup archives, source manifests, rollback script and deployment result
are under `~/.local/state/itms/releases/backend-presence-20260929`.
Rollback uses the previous heartbeat release, not the older inventory-age handler.

Post-deployment database check at 11:38:23 UTC confirmed fresh heartbeats after
restart: ITMS Online (11:38:14 UTC), it.spare Online (11:38:01 UTC), ThinkPad
Unknown (no heartbeat). Shared browser reloaded successfully at `/login`;
authenticated panel verification still requires user sign-in.

The device-detail panel now requests
`GET /api/devices/:id/connectivity?presence=heartbeat`. This scoped backend read
calculates status from the stored heartbeat and returns without calling Salt.
The existing connectivity response remains available for separately loaded Salt
remote-action readiness. A late Salt result cannot replace the displayed
heartbeat status, and heartbeat Online alone never enables remote actions.
The browser only retrieves and displays backend status; it does not ping devices
or calculate heartbeat age. Visible-page reads remain every 15 seconds.

Status and readiness requests have an eight-second deadline, including response
body parsing, so a stalled request leaves the loading state and permits the next
scheduled read. Full backend suite, all 45 device-detail tests, full frontend suite
(786 passed, 2 skipped), TypeScript, scoped lint, production build and editor
diagnostics passed. Tests cover heartbeat rendering while Salt is stalled,
independent action readiness, and timeout recovery on the next poll.

## Agent heartbeat - September 29, 2026 - two endpoints reporting

After publication, the user approved heartbeat enablement on **all three devices**.
All are Ubuntu systems. Exact-target Salt probes reached `itms` and `it.spare`;
`zerodha-admin-ThinkPad-E14-Gen-4` returned a negative ping response.

- `ITSPARE-3F56D0EA`: heartbeat enabled and verified Online at 10:56 UTC. A
  checksum-pinned copy of the published Python collector was installed separately
  as `/opt/itms/heartbeat-20260929.py`; the existing inventory collector, protected
  configuration and inventory timer were not modified. The new heartbeat timer
  is enabled and active; the server recorded a heartbeat at
  `2026-09-29T10:56:21.613039Z`. Inventory `last_seen` stayed
  `2026-09-29T09:03:48Z`. Collector-derived identity was checked before enablement.
- `ITMS-B24CD81C`: user confirmed continuation on both remaining devices;
  heartbeat-only setup completed through Salt at 11:07 UTC. The pinned collector
  is `/opt/itms-heartbeat/heartbeat-20260929.py`, with separate root-owned mode
  0600 `/etc/itms-heartbeat.env`. The existing backend ingest credential was read
  locally on this host, not transmitted in Salt job arguments or printed.
  Collector-derived identity matched the registered asset before configuration.
  The heartbeat timer is enabled and active, service exit status is zero, and
  the server recorded an Online heartbeat at `2026-09-29T11:07:46.699168Z`.
  Inventory `last_seen` remained `2026-09-28T11:36:33Z`; no inventory task was added.
- `ZERODHAADMI-8BF45CB3`: no successful Salt ping; no changes were made. Restore
  endpoint management connectivity before attempting the update. A subsequent
  bounded read-only management request still returned no usable command result.

Rollout helpers are in the private release directory:
`endpoint-heartbeat.cjs` and `enable-endpoint-heartbeat.py`. Deployment is currently
restricted to the preflighted `it.spare` and `itms` targets and refuses existing heartbeat
files. No full installer, security scan or inventory collection was run. All three
inventory timestamps matched the pre-update baseline. Reboot recovery and the
authenticated browser display remain unverified.

### Earlier server and installer publication

Backend, frontend and migration deployed with user approval at 09:48 UTC.
The user subsequently approved **installer publication only**, including the
earlier inventory-collection improvements, and ran the administrator publication
command at 09:55 UTC. All five installer/collector files now match the staged
release and have been independently verified through their public HTTP URLs.
At publication time no device was updated, no installer was run on an endpoint,
and publication restarted no services. Backend and PostgreSQL remained healthy.
All three assets had no heartbeat at that point; the later approved partial
endpoint rollout is recorded above.

Publication result and original-file backups are under the release directory as
`installer-publication-result.json` and `installer-publication-backup/`.
Use `node publish-installers.cjs verify` from that directory to recheck the five
published files. The server deployment result's `installersUnchanged` field
describes the earlier 09:48 server cutover, not this later approved publication.

Release: `backend-backend:release-heartbeat-20260929`, image ID
`sha256:bd6bd04d7e4fe44c4ff1d59cd09b90044f64a276f33d1ebd38c031c212b3ab3f`.
Backend binary SHA-256:
`716308decef425481b9d23a42cf9446166065a7f51372c12ac0c0b645a315aed`.
Frontend entry: `assets/index-CIQy9ZGZ.js`; HTML SHA-256:
`a5dd0bcffb298b72a1854461c6088e76ea4f5bbe401298d61c09f3f7b32be2eb`.
All 43 frontend files were verified over HTTP, and the real live browser loaded
the new entry at `/login`. Authenticated browser workflows remain unverified.

Backend/database health and direct/proxied health endpoints passed. PostgreSQL
container identity and start time were unchanged; nginx, Salt master/API and Wazuh
manager remained running. Effective backend environment was preserved. Migration
051 brought the applied count to 54. Business counts stayed at 3 users, 3 assets,
11 departments, 0 gatepasses, 1 request, 0 installation scripts and 0 stock items.
Unauthenticated heartbeat and directory-status requests still return 401.

Private backups, checksum manifests, active compose override, migration rehearsal,
release image context, staged installers and deployment result:
`~/.local/state/itms/releases/heartbeat-20260929`. Database archive listing and
checksums passed; isolated restore/migration preserved all 60 business-table
fingerprints. The temporary database and synthetic browser preview were stopped;
the preview token was cleared. Previous backend and frontend backups remain
available. PostgreSQL was not recreated.

The directory and device detail now derive presence from the same server-recorded
`assets.last_heartbeat_at`, introduced by migration
`backend/db/postgres_migrations/051_device_heartbeat.sql`:

- Online: a heartbeat received within the last 90 seconds, inclusive.
- Offline: the last heartbeat is older than 90 seconds. This means no recent
  contact, not proof that the computer is powered off.
- Unknown: no heartbeat recorded, or an invalid future timestamp. Existing agents
  are not marked offline merely because they have not received this update.
- User rows aggregate their devices: any online device wins, otherwise unknown
  wins over offline; an owner without devices stays unassigned. A single-device
  detail can legitimately differ from a multi-device owner's aggregate.
- Visible-page polling remains 15 seconds. Views can briefly differ near the
  90-second boundary because they read at different times, but neither uses
  individual Salt ping results to determine heartbeat presence.

`PUT /api/assets/heartbeat` keeps the existing inventory-token authentication and
asset-tag identity contract. It accepts bounded JSON, updates only an existing
compute asset, and returns the actual server receipt timestamp. It does not create
assets or update `asset_compute_details.last_seen`, inventory sections, software,
or security scans. No inventory timestamp is backfilled as a heartbeat.
The endpoint still trusts the shared ingest token; this is not per-device
credential isolation or cryptographic device attestation. Use protected transport
and retain existing credential-file restrictions. Agents must use their registered
asset tag; custom tags or hostname changes require checking that identity matches.

Directory status reads make no Salt calls. Device detail returns heartbeat
presence plus a separate `salt` readiness result. The UI displays last heartbeat
and Salt readiness independently; remote-action buttons still require a successful
Salt check, not merely a recent heartbeat. The frontend accepts the previous
Salt-only response during rollout.

Schedules are separate from the existing six-hour inventory refresh:

- Linux: `itms-heartbeat.timer`, every 30 seconds, 1-second timer accuracy;
  `itms-heartbeat.service` runs the Python collector with `--heartbeat-only` and a
  20-second service limit.
- macOS: `com.itms.heartbeat` launch daemon, `StartInterval=30`, `RunAtLoad=true`;
  the same Python heartbeat-only mode reads the protected existing configuration.
- Windows: `ITMS Agent Heartbeat`, running as SYSTEM with `-HeartbeatLoop`;
  approximately 30-second cadence, startup trigger and a one-minute restart
  trigger, overlapping instances ignored, battery operation permitted.

Each heartbeat makes one PUT request with a 10-second HTTP timeout, without a
full inventory scan or redirects. Failures emit a generic message without tokens
or response bodies; the next scheduled heartbeat retries. A first heartbeat may
receive 404 until the initial inventory upload has registered the asset.

Validation: full offline Go suite; 784 frontend tests passed, 2 skipped (including
132 focused directory/detail/model tests); TypeScript, scoped
lint and production build; 37 mocked collector/static installer tests; individual
Linux/macOS `bash -n` checks. Synthetic browser checks cover online/offline/unknown
in directory and detail at 1440px and 390px, no page overflow, and online heartbeat
with unavailable Salt leaving actions disabled. Native Windows/macOS installation
and real heartbeat delivery remain unverified. PowerShell is
not installed in this environment; Windows checks are static only.

Remaining agent rollout requires explicit endpoint selection and approval to
update those devices. The server release and matching installer bundle are live,
including the approved earlier inventory changes. Publication alone does not
install heartbeat tasks on
existing endpoints. Verify task restart after reboot, fresh server receipts,
unchanged inventory dates, and the transition after contact stops on a canary
before wider rollout. Retain the additive column on rollback; do not roll back to
the old heartbeat handler while new tasks run, because it refreshes inventory age.

## Enrollment route repair - September 25, 2026

Deployed backend-only at 12:23 UTC with explicit approval. An endpoint reported
curl HTTP 404 while running an encoded Linux installation command. Nginx logs
showed the installer GET succeeded with 200, followed by a 404 for
`POST /api/inventory-sync/enroll`. The exchange handler existed but was not
registered in NewRouter; both direct-backend and proxied invalid-token probes
confirmed the missing route. Encoding was not the cause.

Registered the existing enrollment-token exchange with rate limiting. A real
router test checks success with a synthetic enrollment token, no-store output,
and rejection of missing, invalid and ordinary login tokens. Full offline Go
tests passed. Live invalid-token probes now return 401 rather than 404 through
both backend and endpoint-facing URLs. No real token exchange or endpoint
installation was performed. Generate a fresh command before retrying; do not
reuse enrollment tokens pasted into chats or logs.

Image: `backend-backend:release-enrollment-route-20260925`, image ID
`sha256:71bb888e4e770eb77b4320ba68e7ca3c467c2ef50343f8894ce257cb38865c8a`.
The image reuses the preceding runtime image and replaces only the Go binary.
All 53 migrations are unchanged, none pending. PostgreSQL identity/start time,
effective backend environment, live frontend and installer hashes were preserved;
business counts remained 3 users, 2 assets, 11 departments, 0 gatepasses,
1 request, 0 installation scripts and 0 stock items.

Private database/runtime backups, checksums, source manifest, active compose
override and release results: `~/.local/state/itms/releases/enrollment-route-20260925`.
Database dump listing and checksums were validated; no restore was performed.
The prior backend release and compose override remain under
`~/.local/state/itms/releases/bulk-employees-20260924`. A backend rollback must
preserve effective configuration and use `--no-deps --no-build --pull never --wait`
for backend only; it would reintroduce the missing enrollment route.

## Encoded install commands - September 25, 2026

Deployed frontend-only on September 25, 2026 at 06:04 UTC. This does not publish
or upgrade the collector/installer changes described elsewhere in this guide.
The Install new monitoring agent dialog defaults
to Encoded, with a Readable option for inspecting the original command. Copy
command copies the selected format. Switching formats makes no additional API
request and preserves the same enrollment token and installer arguments.

- Windows: `powershell.exe -NoProfile -EncodedCommand` with UTF-16LE Base64.
- Ubuntu/Debian and Fedora/RHEL: UTF-8 Base64, decoded with `base64 --decode`
  and executed with `bash -c`.
- macOS: UTF-8 Base64, decoded with the native `base64 -D` and executed with
  `bash -c`.

Use the existing administrator/sudo requirements. Encoding is not encryption,
does not extend token expiry, and does not bypass PowerShell execution policy.
Keep both formats private. The backend API, enrollment authorization, installer
files, collector schedules, and production services are unchanged.

Validation: 14 focused modal tests, TypeScript, scoped lint and production build
passed. Tests cover Unicode/quotes/newlines, all four platform formats, readable
selection, exact clipboard contents, fallback copying and OS-change clearing.
Harmless Linux/Fedora printf payloads were executed through the actual encoder;
macOS wrapper syntax and Windows UTF-16LE round trips were checked. Native
Windows/macOS execution and real agent installation were not performed.
Synthetic browser checks at 1440px and 390px verified format switching and no
horizontal page/command overflow, with no backend connection or real token.

Release entry: `assets/index-BBchFi18.js`. HTML SHA-256:
`a3434cb050c6fb78227b6ff6ff63e9a27bafd54e8151384e209ed7a7b758d4de`.
All 43 frontend files passed HTTP byte verification; the live login page loaded
the new entry. Backend and PostgreSQL remained healthy with unchanged container
identities/start times; installer hashes were unchanged. No production agent
installation, account changes, imports, migrations or restarts were performed.
Authenticated live command generation and native Windows/macOS execution remain
unverified. The synthetic preview was stopped and its test token cleared.

Private backup, source/build manifests, publication script and deployment result:
`~/.local/state/itms/releases/encoded-agent-20260925`. The previous frontend
archive was checksummed and its tar listing verified before publication. Old
hashed assets were retained; the publisher restores the previous index on failed
HTTP/health verification. Rollback is frontend-only: preserve installers and
services, restore the backed-up index with mode 0644, and verify served bytes.

## Discoverable scopes, not “everything”

“All” means all discoverable items in the stated collector scope and within its
reported bound. It does not mean every app, service, user profile or update on a
machine. Existing software/update behavior and manual ownership are unchanged;
see [inventory-telemetry-contract.md](inventory-telemetry-contract.md).

| Platform | Software (existing) | Services (new) |
|---|---|---|
| Linux | dpkg/RPM including dependencies, snap, flatpak apps visible to the collector, collector-user pip, global npm | `systemctl list-unit-files --type=service --no-pager --no-legend --full` plus `list-units --all --type=service --no-pager --no-legend --plain --full`; system manager only, not user managers or non-systemd init |
| macOS | Homebrew from PATH or standard Intel/Apple Silicon location; application roots `/Applications`, `/System/Applications`, collector-home `Applications`, each at most one category level deep; collector-user pip, global npm | root `launchctl list`: loaded system-domain jobs, including loaded jobs with no PID; **not unloaded jobs or GUI/user domains** |
| Windows | machine 32/64-bit uninstall registries, loaded-user registries, all-user AppX | `Win32_Service`, including stopped/disabled services; not kernel drivers or other user-session inventories |

Linux unit-file start mode is retained separately from runtime `active/substate`.
Unit files absent from the runtime listing have **unknown** state, not a fabricated
stopped/running state. Transient loaded services may have unknown start mode.
macOS reports running/stopped from PID presence, not exit status; start mode is
unknown. Non-root macOS scans are unsupported rather than mislabeled as system
scope. No launchdaemon plist contents are read. Windows uses State and StartMode,
not generic CIM health Status, and explicitly requests only Name, DisplayName,
State, StartMode. No service command lines, environments, accounts or credentials
are collected. Linux/macOS use the service identifier as the display name.

Portable apps, unloaded Windows user hives, every language environment and user
launch agents are outside these promises. Update scans describe OS package/update
providers, not every third-party app; cached Linux metadata may itself be stale.

### System information and update coverage

| Section | Linux | macOS | Windows | Completeness boundary |
|---|---|---|---|---|
| Hardware / identity | CPU/RAM, physical disks, lsblk volumes, firmware, OS/build, GPU/display, boot time, machine identity | sysctl/system tools, OS/build, GPU/display, root-volume diskutil metadata, hardware identity | CIM CPU/RAM, fixed logical disks, firmware/OS/build, GPU/display, boot time, volumes | Best effort, **partial even when populated**: optional helpers suppress failures, so populated fields do not prove every provider succeeded. Windows required-CIM errors abort the upload; they do not submit an empty successful snapshot. |
| Network | Visible non-loopback IPv4 interfaces, routes, DNS; some virtual/down interfaces excluded | IPv4 interfaces, hardware-port mapping, routes, DNS | IP-enabled CIM adapters, MAC, IPv4, gateway, DNS | Python reports partial because provider completion is unverified; Windows reports success only when its CIM query/parsing completes, failed otherwise. No full IPv6 or every interface/profile guarantee. |
| Remote IDs | Installed AnyDesk/RustDesk `--get-id` | Same, including known app paths | Same, including known Program Files paths | Numeric observations only: partial if an ID is available, uncollected otherwise; absence cannot distinguish missing installation from failed query. No passwords or remote-access capability guarantee. |
| Updates | apt list or cached dnf/yum check-update | softwareupdate list | Windows Update COM software search | Successful bounded provider result only; failed/partial count is null, not zero. Not an all-app update/security certification. |

Each reported section has collector time, source and status. Software and services
default to 5000 records, maximum 10000. `--software-limit` / `-SoftwareLimit` and
`--service-limit` / `-ServiceLimit` are **collector flags, not installer flags**.
`--no-software-scan` / `-NoSoftwareScan` marks software uncollected; services and
updates still run. Neither installer uses that skip flag. Python clamps bounds to
1–10000; PowerShell parameter validation rejects out-of-range bounds.

Malformed package responses and unreadable macOS app directories are failed or
partial, never authoritative empty. Software names/versions are not silently
shortened. Overlong/invalid service identifiers are omitted with failure/partial
metadata rather than turned into a different identity; altered Windows display
metadata is partial. Unknown runtime/start-mode fields remain unknown. A successful
upload means delivery succeeded, **not** that all sections are complete or current.

## Additive contract and retention

- Ingest adds `asset.services`: an array of `{name, display_name, state, start_mode,
  source}` and `asset.collection_status.services` with `status`, `source`,
  `scanned_at`, `scope`, `total`, `returned`, `truncated`, `truncated_count`, and
  optional sanitized `error`. Status is success/partial/failed/unsupported;
  uncollected is also accepted for compatibility. Errors never carry raw output.
- Default collector bound: **5000**, configurable by `--service-limit` / `-ServiceLimit`,
  maximum **10000**. Counts describe unique discovered/emitted items. Truncation
  is partial, never authoritative empty. Each native query has a 60-second
  timeout; Windows isolates CIM in a 60-second job with 45-second operation timeout.
- New [045_service_inventory.sql](../backend/db/postgres_migrations/045_service_inventory.sql)
  creates the add-only, idempotent `asset_service_inventory` table: one JSON
  snapshot and section metadata per asset, maximum 10000 rows, last successful
  receipt timestamp, and latest attempt receipt timestamp. It does not execute
  commands or alter management, software, ownership or update schemas.
- Explicit successful, complete `[]` clears a previous snapshot. Missing/null
  arrays, inconsistent counts, malformed rows, reported errors or truncation
  cannot replace it. Partial scans merge by `(source, name)` and update observed
  state, without inferring removal. At storage capacity existing keys win;
  omitted new observations are reported in `truncated_count`/error. Failed,
  unsupported and uncollected attempts retain rows and last-success time while
  updating status. Omitted/legacy service sections leave the whole snapshot intact,
  even if an unqualified service array is present.
- Fields are bounded (name/display 256 characters; state/start mode/source 64);
  control characters are removed. Backend sanitization downgrades an altered
  “successful” snapshot to partial. Unknown JSON fields are not stored.
- Writes share the existing asset transaction and per-device locking. Service
  state/order-independent bounded fingerprints participate in `inventory_changed`;
  polling timestamps do not cause history. History stores a digest/status/count,
  not thousands of rows. Existing software/update/manual-ownership rules remain.

## Device reads and staleness

Existing scoped `GET /api/devices/:id` adds `services`, `servicesLastSuccessAt`,
`servicesUpdatedAt`, and `collectionStatus.services` via `deviceTelemetry`.
No frontend or management endpoint is implemented here. Existing access checks
are unchanged. Snapshot metadata is read even when a legacy collector overwrote
the general telemetry section map. Never-collected devices return `services: []`,
uncollected status and null timestamps, **not proof of no services**.

`scanned_at` is collector time; the two top-level timestamps are backend receipt
times. `servicesUpdatedAt` advances on an explicitly reported attempt;
`servicesLastSuccessAt` only on complete success. Partial snapshots mix newer
observations with retained older rows (no per-row freshness claim). Failed scans
show retained data alongside failure status. Legacy/omitted sections do not
refresh these timestamps. Consumers must display scope/status/age and must not
treat an old successful receipt or retained running state as current liveness.

## Installer source audit (2026-09-21; never executed)

| Source | Schedule / initial upload | Findings |
|---|---|---|
| [Linux installer](../scripts/install-itms-agent.sh) | `--refresh-hours N`, default 6; root systemd timer `OnBootSec=5min`, `OnUnitActiveSec=6h`; explicit initial push | regular job invokes installed Python collector with `--software-limit 5000`; service limit defaults to 5000; daily 12:00 ClamAV job also collects inventory |
| [macOS installer](../scripts/install-itms-agent-macos.sh) | `--refresh-hours N`, default 6; root LaunchDaemon `StartInterval=21600`, `RunAtLoad=true`; explicit initial push | selected Python collector with `--software-limit 5000`; service defaults apply; initial launch and explicit push can overlap; ClamAV enabled on each refresh, optional CVE scan may delay upload |
| [Windows installer](../scripts/install-itms-agent.ps1) | `-RefreshHours N`, default 6; SYSTEM task `/SC HOURLY /MO 6`; explicit initial push; daily 12:00 AV task | installed collector with `-SoftwareLimit 5000`; service defaults apply; detailed hardware defaults true and is read from config as data; refresh accepts 1–23 hours (schtasks HOURLY limit), task registration nonzero exits now throw |

Installer input flags: Linux supports `--server-url`, `--token-file` or
`--prompt-token` or `--enrollment-token`, `--collector-url`, and optional
`--use-hardinfo-fallback`. macOS supports `--server-url`, `--prompt-token` or
`--enrollment-token`, and `--collector-url` (no token-file flag). Windows supports
`-ServerUrl`, `-TokenFile` or `-PromptToken` or `-EnrollmentToken`, `-CollectorUrl`,
and `-UseDetailedHardwareInventory` (actual PowerShell boolean; defaults true).
All accept category/owner metadata; those inputs do not broaden collection scope.

Linux prefers the adjacent Python collector unless `--collector-url` is given;
otherwise it downloads from the configured server. Windows prefers the adjacent
PowerShell collector unless `-CollectorUrl` is supplied; without an adjacent copy,
the override or server installer URL is downloaded. Explicit collector URL overrides
now take precedence over adjacent copies on both platforms (fixed in this audit).
macOS always downloads the Python collector
from its override or server installer URL. Therefore an old adjacent/downloaded
collector can still produce old behavior: source changes alone are not rollout.
The installed collector is reused on each job, not downloaded at every refresh.

Windows task registration failure checks and refresh range validation were added
in this continuation, along with Linux/Windows collector-URL precedence fixes;
the macOS installer source required no edits here.
Generated backend commands are owned separately and were **not validated in this
scoped continuation**. Existing scheduled agents
do **not** acquire a new collector just because repository sources changed: update
their installed collector or rerun an appropriately reviewed installer separately.

Prior audit evidence (not repeated in this continuation): SHA-256 comparison of five explicit script basenames against the
published installer directory found **all five different before this change**.
Prefixes below identify the audit evidence, not final build hashes:

| File | Checkout before edits | Published |
|---|---|---|
| [install-itms-agent.sh](../scripts/install-itms-agent.sh) | 6363ee173ac95f70 | bba01bffb5034dba |
| [install-itms-agent-macos.sh](../scripts/install-itms-agent-macos.sh) | 4e6829b43b636011 | 3964989463349e15 |
| [install-itms-agent.ps1](../scripts/install-itms-agent.ps1) | c041e6ce04d12c65 | df89c1ac22de5289 |
| [push-system-inventory.py](../scripts/push-system-inventory.py) | 1accb39bbf0c6690 | c986aaceca042d0e |
| [push-system-inventory.ps1](../scripts/push-system-inventory.ps1) | a698cb9cb771e933 | 346d5b263a896827 |

Hashes establish drift, not which behavior is deployed. No published file was
changed and no installed endpoint's collector was inspected or executed.

## Release prerequisites and validation boundary

Apply migration 045 with the existing telemetry prerequisites, deploy the backend,
and distribute updated collectors in a separately authorized release. This work
is **not deployed**: no live collection, installer execution, database access,
migration application, secrets/environment-file reads or publication occurred.
Migration 046, management endpoints and frontend are owned separately.

This continuation validates only scripts and coverage documentation/tests with
Python command/filesystem mocks and static installer/PowerShell assertions.
Windows checks are static because PowerShell is unavailable. Native Windows
5.1/CIM/job behavior, real macOS launchd, distro systemd output and PostgreSQL
migration execution/idempotence still require isolated staging validation.

Continuation checks: **33 Python tests passed** with bytecode writes disabled;
`bash -n` passed for both Linux/macOS installers. PowerShell and ShellCheck are
unavailable: no native PowerShell parse/CIM/job/task test or ShellCheck run is
claimed. No backend/frontend tests were run or files edited in this continuation;
earlier Go validation belongs to its separate owner. Existing concurrent worktree
changes were preserved. The tests never invoke an installer, collector entrypoint,
upload, package manager or service mutation. `--print-only` / `-PrintOnly` are
**not safe test substitutes**: they still perform real collection (and configured
optional security scans), so they were not run.