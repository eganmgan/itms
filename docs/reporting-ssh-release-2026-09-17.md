# Reporting and SSH release — 2026-09-17

## Current login/navigation correction

- Current frontend: `assets/index-5adXX5cA.js` and `assets/index-C6w0NR-O.css`.
- `/login` now renders only the standalone login page, without the operations
  header, directory or assistant. Sign-in actions navigate there; successful
  password/MFA completion opens `/devices` after receiving a nonempty token.
- Top-level navigation and browser history now update the visible page together.
- Unsupported remember-session behavior was removed; Google sign-in is explicitly
  unavailable and password recovery directs users to their administrator.
- Existing backend authentication/MFA contracts are unchanged by this UI fix.
- 167 frontend tests, lint, TypeScript and build passed. Live `/login`, `/devices`
  and `/api/health` returned HTTP 200. Browser checks at 1440px and 390px confirmed
  one login form, no directory/operations header, and no horizontal overflow.
- Previous index backup:
  `/tmp/itms-release-20260917-100426/index-before-login-fix.html`.
- No real credentials were submitted during verification. The physical-device
  database record remains confirmed; authenticated browser verification is pending.

## Frontend correction after inventory regression

The detached worktree was not the actual latest frontend baseline. Publishing it
restored older components, including an older authentication interface. The
previous live frontend was first restored from its backed-up entry document.
The corrected main frontend was then tested and published:

- Current entry: `assets/index-DDWxocV1.js`.
- Current stylesheet: `assets/index-DZ0Dkmp0.css`.
- 134 frontend tests passed; TypeScript/build/lint passed.
- Device Directory no longer substitutes demo inventory when signed out. It
  displays an explicit sign-in action, clears stale data after account changes
  or authorization failures, and opens the existing identity/password/MFA form.
- The header no longer presents a hardcoded signed-in user.
- Both compute assets, including the physical ThinkPad enrolled September 15,
  were confirmed present by read-only database queries. No inventory was modified.
- The shared live browser successfully displayed the corrected sign-in state and
  opened the authentication form. Authenticated device display still requires the
  user to sign in directly; no token was present in the shared browser.
- Backend release and installer files were unchanged by this correction.

The deployment-worktree bundle identifiers below describe the superseded release,
not the currently published frontend. Use the main frontend as the baseline for
subsequent work; do not republish the stale detached worktree.

## Deployed artifacts

- Frontend prepared in the existing detached deployment worktree, retaining its
  application routing/authentication and unrelated interfaces.
- Frontend entry: `assets/index-DMXu9GJH.js`; stylesheet:
  `assets/index-CeponYmH.css`. Existing hashed assets and installers were retained.
- Backend image: `backend-backend:release-20260917-report-ssh`.
- Backend image ID:
  `sha256:dfdb5cb4c62bba927692f65adfba783d95acd1cab42990588b9ff7c5fba6a07e`.
- Server binary SHA-256:
  `0663df314489b467e4dd8b280bfb52c8ff7dc43616e2fe36e342174d24e29eee`.
- Image overlays the new binary on the previous runtime; all 43 migration files
  matched the source and were retained unchanged. PostgreSQL was not recreated.
- Broader current backend source was explicitly approved because the exact
  deployed source baseline was unavailable. Authenticated AI routes were restored;
  employee-ID login retains password, active-account, domain, MFA and rate checks.
  Passwordless demo-login expectations were replaced with rejection tests.

## Validation

- Scoped deployment frontend: 85 tests passed, TypeScript/build/lint passed
  (existing dashboard lint and large-bundle warnings remain).
- Backend: full `go test -mod=readonly -count=1 ./...` passed; focused
  auth/AI/SSH/patch/report race checks passed.
- Deployed backend/container healthy; `/api/health` reports database up.
- SPA routes `/patch/logs`, `/patch/reports`, `/patch/ssh` returned HTTP 200;
  published entry files matched generated assets.
- Authenticated report downloads and real-device SSH remain unverified: the shared
  live browser had no application token, even after the user reported signing in.
  No credentials were requested in chat and no authentication bypass was used.

## Runtime configuration recovery

The initial Compose recreation failed because its environment files omitted
`DATABASE_URL`. Both release and rollback images could not connect to PostgreSQL.
The previous image was restored to healthy operation before the release was retried.

Database configuration was recovered from the running PostgreSQL container's
existing environment into a private mode-0600 runtime file, without printing or
changing credentials. Backend Compose now requires this extra environment file:

- Override location using `ITMS_DATABASE_ENV_FILE`.
- Default: `$HOME/.config/itms/backend-database.env`.
- Required entry: `DATABASE_URL` pointing to the internal database service.
- Keep this file outside Git and readable only by the deployment account.
- Use the same deployment account or set an explicit override when recreating
  the backend. Do not print expanded Compose configuration in logs.

The existing PostgreSQL container was left unchanged. Before any future PostgreSQL
recreation, separately verify its secret configuration; this backend-only recovery
does not repair or validate database-container provisioning.

## Rollback references

- Backend image: `backend-backend:rollback-20260917-100426`.
- Private release backup directory: `/tmp/itms-release-20260917-100426`.
- Frontend archive: `served-frontend.tgz` in that directory.
- Original frontend source backup:
  `/tmp/itms-frontend-20260917-065823-backup.tar.gz`.

For backend rollback, restore the rollback image tag and recreate **only** the
backend with the recovered runtime environment file. Wait for health before
proceeding. A failed image rollback alone will not correct missing configuration.
For frontend rollback, restore backed-up assets first and atomically publish the
backed-up entry document last; never delete installers or active hashed assets.

Backups under `/tmp` are temporary and must be retained elsewhere through the
normal operations backup process before host cleanup or reboot. No Git commit
or push was performed as part of deployment.