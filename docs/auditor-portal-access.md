# Auditor Portal Access

## Local Portal Update (2026-10-08)

Implemented locally; not deployed. The production release remains unchanged.

### Employee View Refinement

- Devices lists assigned assets under the employee's email, with a separate View
	action for each asset. Ownership remains enforced by the authenticated user ID.
- Employee device details expose only Overview, Alerts and History. Device
	management, remote commands and update actions are hidden.
- Patch is absent from the default employee portal. Explicit super-admin per-user
	section overrides remain supported and do not grant staff operations.
- Security shows the employee's personal alerts from `/me/alerts`, without staff
	dashboards, integrations, automations or reporting controls.
- Clicking ITMS opens My dashboard for employees with Employee-section access.
- Employee contains Employee Requests and IT Announcements, without the
	Dashboard tab, management sidebar, directory or announcement publishing action.
- Chat requests have a ten-second timeout and failed identity checks can be retried.
	Unconfirmed message delivery still requires a history refresh before resending.

Verification: 208 focused frontend tests passed; the final responsive asset change
also passed all 55 Devices tests. Typecheck, scoped lint and production build passed.
Synthetic desktop/mobile checks covered assigned assets, allowed tabs, minimal
pages, chat creation, assignment and message/reply display. No production messages
were sent; real-account acceptance and deployment remain pending.

### Employee Requests And Warranty

Employees can create software installation, laptop, headphone, mouse, other
equipment replacement, and general IT support requests. The Raise Request form
has four fields: Request type, Asset, Reason and Priority. Request type offers
replacement options from the backend item catalog, such as Laptop replacement,
Mouse replacement or Keyboard replacement, plus software installation and general
IT support. Asset is a required selection from the employee's currently assigned
physical devices and accessories, with the asset tag or item code shown.
`/me/requests/items` returns only catalog IDs and names under Employee-section
access; staff inventory permissions remain unchanged. Loading failures offer retry,
and no assigned assets blocks submission. The subject is generated from the request
type and selected asset; the asset identifier is included in the description. It uses the
existing `/me/requests` API and staff request queue; existing assignment rules and
fallback settings are unchanged. No software installation or replacement is
automatically approved or executed.

Request history shows the ticket number, current status, assignee, creation/update
times, resolution notes and staff comments. Submission is locked while pending;
an unconfirmed result requires checking history before another attempt. Account
changes abort the form and clear the previous account's view.

Warranty notifications use the employee-scoped `/me/assets` response, including
assigned accessories. They show expired warranties, expiry today, and expiry within
30 days. Notifications are informational only, with no replacement-request button.
Missing or invalid dates do
not produce expiry notices. These are in-app notices, refreshed while the Employee
page is visible and when focus returns; no background email/push job was added.
Assigned-asset access is required to select an asset in the request form.

My dashboard shows assigned-item, open-alert and request totals, an item-type
bar chart, an open-alert severity chart, and the employee's current items. Data is
self-scoped; unavailable data is not represented as zero. Device and Security
section restrictions remain enforced independently by the API.

Security and the Dashboard display the alert title, explanation, source, device,
severity, status and detection time. Each alert has an explicit Send to IT action
that creates a `security_alert` request in the existing staff queue and returns its
ticket number. This is not an automatic email, chat broadcast or endpoint action.
Existing request assignment rules still apply. Pending submissions are locked;
unconfirmed submissions require checking history before another attempt. The
per-view success lock is not persistent deduplication across navigation or reloads.

Validation: 101 focused Employee, Security and App tests passed, along with types,
scoped lint, editor diagnostics and production build. Earlier backend catalog
authentication, section-access and personal-request tests passed. Synthetic desktop
and mobile checks covered replacement types, assigned-asset selection, submission,
history, chart rendering and notification-only warranties. The isolated preview keeps
sample requests in memory only; they disappear when its server restarts. This
follow-up is also local only and not deployed.

| Role | Default sections | Access |
| --- | --- | --- |
| Employee | Devices, Security, Employee | Existing employee-scoped permissions |
| IT team | Devices, Patch, Security, Employee, Gatepass | Existing staff permissions |
| Auditor | Devices, Patch, Security, Employee, Gatepass | Read-only |
| Super-admin | All sections | Can configure sections per user |

Super-admins open Employee > Employee Directory > View details > Portal sections.
Select sections and choose Save sections, or Role defaults to remove the override.
An empty selection disables all five sections. Overrides are per user, not per role.
Section selection never promotes a role or grants an operation forbidden by existing
role/entity authorization. Super-admin sections cannot be restricted.

The chat popup contains real conversations only; AI/IT Guidance is removed from the
UI. Auditors do not get chat. Existing chat assignment and availability are retained.

The API stores overrides in the existing settings table using canonical user UUIDs;
no migration is required. Authenticated section checks cover legacy and v1 endpoints
and SSH websocket entry. Auditor writes are denied even when sections are customized.
General audit logs remain blocked for auditors; entity-scoped Gatepass audit reads,
request reads, and Patch overview/report reads are permitted. Existing entity scope
checks remain in place. Employee requests use the existing self-scoped API.

The UI verifies access from the server, fails closed on errors, and refreshes on
focus, visibility restoration and every 60 seconds while visible. Backend checks apply
on each mapped request. Already-open command sessions are not terminated by this change.

Focused portal, editor, navigation, chat, page and auditor API tests pass. Types,
scoped lint, production build and synthetic desktop/mobile checks pass. The full
frontend suite has 923 passing tests, 22 pre-existing failures and 2 skipped tests;
the backend has four pre-existing failing tests. Do not publish the dirty worktree.
Deployment requires a separately validated release and explicit approval.

## Historical Policy

The following describes the earlier auditor shell, not the local update above.

## Allowed Auditor Routes

Auditors are limited to the `/audit/*` portal shell and default to `/audit/dashboard`, which redirects to `/audit/alerts`.

- `Users`: directory and user detail views only
- `Devices`: device list and device detail views
- `Stock Inventory`: read-only stock listing
- `Alerts`: entity-scoped alert listing and review
- `Patch`: read-only dashboard and device list
- `Announcements`: read-only announcement feed

## Blocked Auditor Actions

Auditors must not be able to perform the following actions:

- open admin or IT portal routes directly
- access chat or settings through the audit portal
- view user audit logs
- run patch actions or open Salt consoles
- view patch run reports
- acknowledge or resolve alerts
- create announcements
- access terminal or SSH routes

## Frontend Enforcement

- Portal shell redirects are enforced in `frontend/src/App.tsx` through `getPortalAccessRedirect`.
- Standalone role-restricted routes are enforced in `frontend/src/App.tsx` through `getRoleAccessRedirect`.
- Users audit tab is hidden for auditors.
- Patch report panels and report fetches are disabled for auditors.
- Top navigation does not load hidden notification surfaces for auditors.

## Backend Enforcement

- `/api/audit` is restricted to `super_admin` and `it_team`.
- `/api/patch/reports` and `/api/patch/reports/:id` are restricted to `super_admin` and `it_team`.
- `/api/alerts/:id/acknowledge` rejects auditors.
- `/api/alerts/:id/resolve` rejects auditors.
- `/api/announcements` `POST` rejects auditors.
- `/api/chat/*`, terminal, and SSH routes remain non-auditor surfaces.

## Regression Coverage

Frontend regression coverage:

- `frontend/src/lib/portalGuards.test.ts`

Backend regression coverage:

- `backend/internal/api/router_auth_portal_notifications_test.go`
- `backend/internal/api/router_auth_scope_workflows_test.go`

Focused validations used while aligning the portal:

```bash
cd frontend
npm test -- src/lib/portalGuards.test.ts
npm run build

cd ../backend
go test ./internal/api
```