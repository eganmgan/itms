# Device Apps & Services

Frontend route: `/devices/:assetId/apps`.
Backend contract: [Apps & Services API](../backend/APPS_SERVICES_API.md).

## Assistant HTTP fix (deployed 2026-09-30)

Published frontend-only at 11:02 UTC after approval. Chat now uses the existing
`secureUUID` helper for user and local assistant message IDs, supporting HTTP
browsers through `crypto.getRandomValues` when `crypto.randomUUID` is absent.
No backend, authentication, provider configuration or history behavior changed.

Validation: 29 focused chat/UUID tests passed, including local guidance, server
replies and failed-server fallback without `randomUUID`. Types, scoped lint,
editor checks and production build passed. All 44 live static files and checked
SPA routes passed HTTP verification; backend/database containers and installers
were unchanged. Backup and metadata are retained in
`~/.local/state/itms/releases/chat-http-20260930`.

The live HTTP browser loaded `index-Chwpr7Jm.js`, confirmed `randomUUID` absent,
and successfully displayed an agent-install guidance reply. The panel fit
1440px and 390px viewports and finished its sending state. The page was signed
out: authenticated history remains unverified live (server replies are covered
by mocked frontend tests). External AI remains unconfigured; replies use
built-in guidance. No histories were cleared or endpoint actions performed.

## Duplicate tab correction (deployed 2026-09-30)

The legacy Applications tab and its separate inventory table are removed;
Apps is the single application-management tab. Existing
`/devices/:assetId/applications` bookmarks open Apps with the same device scope.
The Services tab is unchanged. Validation: 63 focused tests, typecheck, lint,
production build and synthetic desktop/mobile checks passed.

Published frontend-only at 10:50 UTC. Backup and release metadata are retained
in `~/.local/state/itms/releases/single-apps-tab-20260930`. All 44 static files
and checked SPA routes passed HTTP verification. Backend/database containers
and installers were unchanged; no endpoint actions occurred. The live browser
loaded `index-CXPj7ZhK.js` but was signed out, so authenticated device controls
remain unverified. The synthetic preview was stopped.

The accompanying assistant check reproduced a separate live failure: sending
on the HTTP site throws `crypto.randomUUID is not a function`, before displaying
the message. No chat fix is included in this release. Four existing frontend
chat tests and the focused backend AI chat route tests pass, but do not cover
this browser limitation. The signed-out history route returns HTTP 401 as
expected; authenticated history was not tested. The running backend has no
AI provider URL or key configured, so its configured behavior is built-in
guidance rather than external model responses. No conversations were cleared.

## Device navigation (deployed 2026-09-30)

Published frontend-only at 10:41 UTC. A fresh frontend archive and rollback
index are retained in `~/.local/state/itms/releases/device-apps-20260930`.
All 44 static files, the device overview/Apps routes, login and Patch routes
were verified over HTTP. Backend/database container identity, image, start time
and health, plus installer files, were unchanged. No endpoint actions occurred.

- Apps is in each system's device sub-navigation, directly below the device
  heading. There is no Apps item in the main navigation and no Apps & Services
  module in Patch. Existing recorded inventory tabs remain available.
- Direct UUID device URLs and their Apps tabs work without first selecting a
  directory row. Tab URLs support reload and browser back/forward.
- App/service controls use the URL's exact device ID and scoped detail API,
  with no system picker or inventory-directory fetch inside the Apps tab.
  Changing device/account clears pending confirmations; server permissions,
  ticket approvals and unknown-outcome recovery are unchanged.
- Former `/patch/apps` and `/patch/apps-services` bookmarks show a link to
  Devices, without mounting app controls or calling Patch execution APIs.
- Validation: 813 frontend tests passed (2 skipped), types/lint/production
  build passed. Isolated browser checks verified desktop/mobile layout, direct
  reload, device navigation, exact confirmation target and retired Patch entry.
  The live browser loaded the new bundle and confirmed no main-nav Apps link,
  but was signed out; authenticated live controls remain unverified. The
  synthetic preview was stopped after publication.

## Previous compact-controls deployment (2026-09-30)

Published frontend-only at 10:20 UTC with a fresh frontend backup. All 43 static
files and the login, Patch and both Apps routes were verified over HTTP.
Backend/database container identity and start time, and installer files, were
unchanged. No endpoint actions were performed. Release metadata and rollback
backup are in `~/.local/state/itms/releases/compact-controls-20260930`.

Validation: 815 frontend tests passed (2 skipped); types, scoped lint and the
production build passed. Synthetic desktop/mobile browser checks verified row
confirmations, search and layout. The live browser loaded the new bundle and
primary Apps link, but was signed out; authenticated live controls remain
unverified. The isolated preview was stopped after publication.

- This earlier deployment placed Apps in primary navigation and removed the
  secondary Patch bar. The device-navigation deployment above supersedes
  that placement.
- App rows offer install/remove icons that open the exact action confirmation.
  A unique matching catalog entry and an available, action-specific ticket
  approval are required. Ambiguous matches require explicit catalog selection.
- Catalog selection, catalog creation and ticket approvals remain available
  under the initially collapsed **Catalog & approvals** section.
- Services use one searchable table with start/stop/restart/enable/disable
  icons. Actions use exact live names; recorded-only rows cannot be acted on.
  State and start mode columns are explicitly recorded values, not live health.
  Linux `.service` suffix matching is not applied to Windows or macOS names.
- A row click opens review only. Final confirmation, server capabilities,
  single-use ticket approval and unknown-outcome recovery remain mandatory.

## Access and execution

- Account-verified, scoped `/devices` selection supports `super_admin`, `it_team`,
  `admin` and `auditor` readers. Execution-only `/patch/devices` is not used here.
- Only `super_admin` / `it_team` with affirmative global and selected-device API
  capabilities may act. Install, management and script histories must load before
  mutations unlock.
- Applications come from the active catalog filtered by the selected device's
  entity and OS, with pagination. Recorded app names never become package IDs.
- Service controls use live discovered names, not stale recorded inventory.
  Supported actions: start, stop, restart, enable, disable. No definition deletion.
- Confirmation names the device, asset UUID, operation and exact approved package
  or service. Dialog focus is contained, Escape cancels, and focus is restored.
- One secure UUID per confirmed intent is retained in session storage before
  dispatch. Storage or secure randomness failure prevents dispatch. Install and
  management UUID namespaces remain separate.
- No mutation retry, redirects, polling or synthetic inventory updates. HTTP
  errors, malformed/mismatched results and unconfirmed persistence retain unknown
  status. Unknown outcomes lock new endpoint actions; manual status recovery uses
  only GET with the retained request UUID. A missing result does not unlock them.
- Account/device changes and unmount abort reads and request waiting, ignore late
  results and discard the old selection/confirmation. Aborting a browser request
  does not undo a remotely dispatched action. Its original journal remains for
  same-account recovery in that browser session.
- Existing super-admin catalog creation remains a separate explicit approval,
  never an implicit installation. Ambiguous creation requires catalog inspection
  before another user-initiated submission; it has no idempotency contract.

## Limits and validation

Single-device operations only. Device selection currently loads the scoped
inventory directory; catalog pages contain up to 50 entries. History shows the
latest 50 installs / 100 management actions plus the browser-session journal.
Closing/clearing the browser session removes its local journal; server history
remains the source of durable outcomes. Unknown requests can remain unresolved
indefinitely and require operator investigation, not another mutation.

Recorded services/apps may be stale, partial or unsupported. Collection coverage
and timestamps are displayed without asserting completeness. Service discovery
does not supply running/enabled states; restart acknowledgement is not a health
check. Management does not trigger collection. Backend migrations 043–046 and
working platform providers are prerequisites, not frontend deployment actions.

Regression fixtures cover navigation, roles, per-device capabilities, loading and
errors, strict payloads, confirmations, keyboard focus, synchronous locking,
unknown/failed/succeeded outcomes, no retry, journal recovery and stale responses.
Run Vitest through its Node API with `envDir: false` when validation must avoid
environment files. TypeScript and oxlint are the existing project checks.
No live endpoint action or OS/provider compatibility is proven by these fixtures.