# Gatepass, Patch Apps and custom password reset — 2026-09-22

## Local changes; not deployed

The served HTML still references `index-Bl_A2iNc.js`, the September 21
frontend-only handwritten-signature release. Current source contains newer
gatepass company-record and Apps & Services implementations. Do not treat
their presence in source as evidence they are live.

- Gatepass sender company is resolved from the selected asset's saved entity;
  receiver company comes from the selected recipient or destination branch.
  Read-only fields now describe these sources and explain missing mappings.
  Missing sender companies block creation. Existing origin autofill, conflict
  rejection, historical snapshots and handwritten signatures are preserved.
  Unknown receivers still require an explicit authorized company, never a guess.
- Patch's submenu now displays **Apps**, opening the Apps & Services page at
  `/patch/apps` (including trailing slash and query strings).
  `/patch/apps-services` remains a supported legacy link. Both routes use
  the same permissions, confirmations and no-retry behavior.
- Employee Directory → View details → Reset password now accepts **New password**
  and **Confirm new password**, instead of generating a password. Existing
  super-admin-only reset permissions and backend password API are unchanged.
  Validation matches backend strength rules and bcrypt's 72-byte limit; values
  are not trimmed. Passwords are masked, never copied/displayed after success,
  and discarded on success or route/account changes. Requests are not retried;
  ambiguous failures explain how to verify the outcome. This does not enforce
  password change at next login or revoke existing sessions.

## Validation

- Final full frontend suite: 34 files passed; 737 tests passed, 1 skipped.
- TypeScript and production build passed. Existing Vite configuration and
  large-chunk warnings remain.
- Editor diagnostics clean for changed feature files.
- Offline backend Gatepass tests passed.
- Earlier full runs failed; the obsolete unnamed navigation assertion was
  corrected. The lazy-route/Patch files then passed together (19 tests), and
  the final full run passed.
- No live password resets, endpoint actions, migrations, publication, container
  restarts, Git commits or pushes performed. Browser/live authenticated behavior
  was not validated by this work.

## Release dependency

Gatepass company detection needs the matching backend and migration 047.
Apps & Services needs its matching backend and migrations 043–046. Review the
full pending release, back up and verify runtime configuration before applying
migrations or restarting services. Do not publish only this frontend against
the older backend. The password-reset change itself uses the existing API.

See [Gatepass records](../backend/GATEPASS_RECORDS.md),
[Apps & Services API](../backend/APPS_SERVICES_API.md), and
[last frontend release](handwritten-gatepass-live-release-2026-09-21.md).

The [coordinated release review](gatepass-apps-password-release-review-2026-09-22.md)
records refreshed local validation, migration/compatibility risks, and outstanding
authorized preflight checks. It is not deployment approval or live verification.