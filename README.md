# ITMS

## Stack

- Frontend: React + TypeScript + Vite
- Backend: Go + Gin + PostgreSQL
- API routing: frontend calls `/api/*` through the shared API helper in `frontend/src/lib/api.ts`
- Live modules: users, assets, devices, patching, alerts, stock, gatepass, chat, announcements, requests

## SaltStack Patch Management Console (Static UI + Node BFF)

This repository now includes a production-style Salt patch console stack implemented as:

- Frontend route: `/admin/salt-patch`, `/it/salt-patch`, `/audit/salt-patch`
- Salt GUI route: `/saltgui`
- Route bridge page: `frontend/src/pages/SaltPatchConsole.tsx` (redirects to portal-aware static UI)
- Static UI page: `frontend/public/salt-patch.html` (pure HTML + Tailwind CSS + vanilla JavaScript)
- Node BFF: `backend/salt-bff` (Express + TypeScript + Postgres + SSE)
- Schema + seed: `db/migrations/001_salt_console_schema.sql`, `db/seeds/001_salt_console_seed.sql`
- Local orchestration: `docker-compose.yml` at repo root (Postgres + Salt master/api + two minions + BFF)
- Smoke test runbook: `docs/salt-stack-smoke-test.md`

Static patch UI behavior:

- Contains four switchable views: Patch Update, SSH Terminal, Jobs History, Reports & Downloads
- Patch execution console streams logs, animates progress, and updates status badges (`IDLE` / `RUNNING...` / `COMPLETED`)
- Every execution creates a generated JID entry appended to Jobs History and Reports datasets
- Header brand link routes back to the correct portal dashboard using route query context (`admin` / `it` / `audit`)

Quick operator flow (about 1 minute):

1. Open one of the portal routes: `/admin/salt-patch`, `/it/salt-patch`, or `/audit/salt-patch`.
2. In **Patch Update**, select target type and execution mode (`cmd.run`, `sls`, or `sh`).
3. Click **Run Patch Execution** and wait for terminal status to move from `RUNNING...` to `COMPLETED`.
4. Open **Jobs History** and confirm the new JID appears at the top with `Success` status.
5. Open **Reports & Downloads** to filter by JID and either:
	- download a single job text record, or
	- export full CSV for audit evidence.

Quick troubleshooting:

1. No live logs in terminal console:
Check execution mode and payload input, then rerun once with a known target (`sys-node-01`).
2. No new JID in Jobs History:
Return to Patch Update and confirm status reached `COMPLETED`; refresh once if needed.
3. Empty report export or missing record:
Clear JID/target/status filters in Reports & Downloads and retry export.
4. Wrong dashboard when clicking ITMS header:
Re-enter through `/admin/salt-patch`, `/it/salt-patch`, or `/audit/salt-patch` to reset portal context.

When to escalate:

1. Two consecutive patch executions fail on the same target group.
2. Status reaches `COMPLETED` but no JID appears in Jobs History after one refresh.
3. CSV export repeatedly returns empty output while Jobs History contains records.
4. Portal context keeps routing to the wrong dashboard after re-entering from a portal salt-patch route.

Escalation ownership (fill these placeholders):

1. L2 Operations Owner: `NAME | PHONE | EMAIL | SHIFT`
2. Backend/API Owner: `NAME | PHONE | EMAIL`
3. Salt/Infra Owner: `NAME | PHONE | EMAIL`
4. Security/Compliance Owner: `NAME | PHONE | EMAIL`
5. Incident Commander (P1/P2): `NAME | PHONE | EMAIL`
6. Escalation channel: `#CHANNEL_NAME` and bridge `MEET/LINK`

Environment variables for BFF (`backend/salt-bff/.env.example`):

- `PORT` (default `4100`)
- `DATABASE_URL`
- `SALT_API_URL`
- `SALT_API_USER`
- `SALT_API_PASSWORD`
- `SALT_EAUTH` (default `pam`)
- `SALT_EVENTS_TIMEOUT_MS`
- `RUN_RATE_LIMIT_PER_MINUTE`
- `MAX_CONCURRENT_RUNS`

Run locally:

```bash
# 1) Start Salt + Postgres + BFF
docker compose up -d --build

# 2) Apply schema + seed
cd backend/salt-bff
npm install
npm run db:migrate

# 3) Start frontend dev server (separate shell)
cd frontend
npm install
npm run frontend:dev
```

Optional frontend env override:

- Set `VITE_SALT_BFF_URL=http://localhost:4100` in `frontend/.env.local`.
- If unset, the salt console API client defaults to `http://localhost:4100`.

Salt integration behavior implemented:

- Auth against Salt `rest_cherrypy` using `/login`, token reused server-side.
- Target mapping: all (`glob:*`), department (`nodegroup`), OS family (`grain`), single minion (`glob`).
- Run dispatch via `client: local_async` and live job returns from Salt `/events` relayed as SSE at `/api/runs/:jid/stream`.
- Run completion writes one `jobs` row and one `audit` row.
- RBAC enforced in BFF (`admin`, `operator`, `viewer`) with `403` on unauthorized mutating actions.

## Port Layout

- Frontend UI should be served on `http://YOUR_SERVER_IP/` through nginx
- Backend API is proxied through the same origin at `http://YOUR_SERVER_IP/api/*`
- Backend container listens on `http://YOUR_SERVER_IP:3001` internally on the host
- Secondary local backend instance is available on `http://YOUR_SERVER_IP:3012`
- **Salt API**: Port 8000 (⚠️ **SECURITY**: Must bind to localhost/private network ONLY - NEVER expose to public internet)

In production, the frontend should use same-origin `/api` and `/ws` through nginx. Leave `VITE_API_ORIGIN` and `VITE_WS_ORIGIN` empty in `frontend/.env.production` unless you intentionally want to bypass the reverse proxy.

## Development

## Submission Docs

- Project overview for submission and review: `docs/project-submission.md`
- ITMS server installation and change approval SOP: `docs/itms-server-installation-approval-sop.md`
- Deployment verification and handoff notes: `docs/deployment-handoff.md`
- Security and release hardening summary: `docs/release-hardening-summary-2026-04-22.md`
- Stakeholder-facing release note: `docs/release-note-2026-07-10.md`
- Auditor portal access and enforcement notes: `docs/auditor-portal-access.md`

Start backend plus stable frontend together from the repo root:

```bash
bash scripts/start-itms.sh
```

This command ensures the backend is healthy, rebuilds the frontend if the built assets are stale, and keeps preview pinned to `4175`.

If `frontend/node_modules` is missing, the helper will install frontend dependencies before it rebuilds or starts preview.

Use this for operator-driven preview sessions, not as the long-running production web server.

Equivalent Make targets from the repo root:

```bash
make start
make start-detached
make stop
make restart
make status
make smoke-test
make installer-smoke-test
```

For a local preview that survives the launching shell, use detached frontend preview mode:

```bash
FRONTEND_BACKGROUND=1 bash scripts/start-itms.sh
```

Or use the dedicated Make target:

```bash
make start-detached
```

The detached preview writes its PID and log under `.run/frontend-preview.pid` and `.run/frontend-preview.log`.

Stop backend plus stable frontend together:

```bash
bash scripts/stop-itms.sh
```

Install frontend dependencies:

```bash
cd frontend
npm install
```

Build the frontend:

```bash
cd frontend
npm run build
```

Start the frontend preview on the fixed live port:

```bash
cd frontend
npm run preview:stable
```

If dependencies are missing, the helper installs them before starting preview.

## Production nginx Deployment

Build and install the frontend behind nginx from the repo root:

```bash
bash scripts/install-itms-nginx.sh --dry-run YOUR_SERVER_IP
bash scripts/install-itms-nginx.sh YOUR_SERVER_IP
bash scripts/install-itms-nginx.sh --http-only YOUR_SERVER_IP
bash scripts/smoke-test-itms-nginx.sh --base-url http://YOUR_SERVER_IP
```

Equivalent Make targets from the repo root:

```bash
make nginx-deploy-dry-run
make nginx-deploy
make nginx-deploy-http
make nginx-smoke-test
make nginx-rollout
```

Use HTTP-only mode for internal networks when TLS is intentionally terminated elsewhere or not required for the segment. This mode installs [deploy/nginx/itms-http.conf](deploy/nginx/itms-http.conf), keeps HTTPS disabled on the host, and serves login at `http://YOUR_SERVER_IP/login`.

`make nginx-rollout` runs the full preview, live deploy, and post-deploy smoke test sequence in order.

The helper script will:

- install frontend dependencies first when `frontend/node_modules` is missing
- build `frontend/dist`
- copy the built files to `/var/www/itms`
- install the nginx site from `deploy/nginx/itms.conf`
- proxy `/api` and `/ws` to `127.0.0.1:3001`
- enable and restart nginx

Use `--dry-run` first if you want to preview the build, sync, nginx config, and service actions without changing the host.

After a live nginx deployment, run `scripts/smoke-test-itms-nginx.sh` to verify the login route, proxied `/api/health`, published installer endpoint, and nginx service state.

To validate live role access across the four primary portals after deployment, run the role-matrix smoke test with the non-admin role passwords:

```bash
API_BASE_URL=http://YOUR_SERVER_IP \
IT_TEAM_PASSWORD='YOUR_IT_TEAM_PASSWORD' \
AUDITOR_PASSWORD='YOUR_AUDITOR_PASSWORD' \
EMPLOYEE_PASSWORD='YOUR_EMPLOYEE_PASSWORD' \
bash scripts/smoke-test-itms-role-matrix.sh
```

The role-matrix script validates expected allowed and forbidden dashboard-related API access for `super_admin`, `it_team`, `auditor`, and `employee` accounts, and exits nonzero if the live permission model drifts.

After deployment, the browser should use `http://YOUR_SERVER_IP/` for both the UI and backend API access through nginx.

Build the backend:

```bash
cd backend
GOTOOLCHAIN=local go build ./...
```

Frontend-specific implementation and bundle notes are documented in `frontend/README.md`.

## Docker Setup On This Server

If Docker is not installed yet, use the one-shot Ubuntu installer from the repo root:

```bash
bash scripts/install-docker-and-start-itms.sh
```

For detached startup:

```bash
bash scripts/install-docker-and-start-itms.sh --detach
```

If you are invoking legacy `docker-compose` v1 directly on this host and `cd backend && docker-compose up -d --build backend` fails with `KeyError: 'ContainerConfig'`, remove the stale ITMS service containers first and then recreate them. The named Postgres volume keeps the database data intact:

```bash
docker rm -f zerodha-itms-backend zerodha-itms-postgres || true
cd backend
docker-compose up -d
docker-compose up -d --build backend
```

For normal day-to-day recovery on this host, prefer `bash scripts/start-itms.sh`, `bash scripts/start-itms-backend.sh`, `make start`, or `make run` instead of calling legacy `docker-compose` directly.

After the stack starts, verify service and API health:

```bash
bash scripts/verify-itms-stack.sh --sudo
```

To verify the live Salt, Wazuh, ClamAV, and OpenSCAP workflows against the current host:

```bash
bash scripts/verify-itms-security-integrations.sh
```

The verifier auto-uses passwordless sudo for OpenSCAP when available. To force or disable that behavior explicitly:

```bash
bash scripts/verify-itms-security-integrations.sh --openscap-sudo always
bash scripts/verify-itms-security-integrations.sh --openscap-sudo never
```

If Ubuntu or Debian package sources do not include the SCAP datastream you need, fetch it into the current user's ITMS content directory:

```bash
bash scripts/setup-itms-openscap-content.sh --print-path
```

To install a persistent host-side OpenSCAP scan timer without running the full agent bootstrap:

```bash
sudo bash scripts/install-itms-openscap-runner.sh --server-url http://YOUR_SERVER_IP:3001 --token "$INVENTORY_INGEST_TOKEN"
```

If root-level installation is not available, install a user-level OpenSCAP timer instead:

```bash
bash scripts/install-itms-openscap-user-runner.sh --server-url http://YOUR_SERVER_IP:3001 --token "$INVENTORY_INGEST_TOKEN"
```

To check the current OpenSCAP timer state and latest ingested OpenSCAP alert in one command:

```bash
bash scripts/check-itms-openscap-status.sh
bash scripts/check-itms-openscap-status.sh --json
```

To run the full deployment readiness suite in one command:

```bash
bash scripts/check-itms-release-readiness.sh
bash scripts/check-itms-release-readiness.sh --with-live-integrations
```

Before running the readiness suite, make sure `backend/.env` and `backend/.env.secrets` exist. The wrapper now checks those files up front because `backend/docker-compose.yml` requires both.

The readiness suite now includes the Linux installer smoke test and an nginx frontend deployment dry-run.

To acknowledge or resolve the latest unresolved OpenSCAP alert for this host:

```bash
bash scripts/manage-itms-openscap-alert.sh --action acknowledge --dry-run
bash scripts/manage-itms-openscap-alert.sh --action resolve
```

Then run the API smoke test:

```bash
bash scripts/smoke-test-itms-api.sh
```

To verify that the Linux bootstrap installer source, deployed web copy, and live download are still aligned:

```bash
bash scripts/smoke-test-itms-installer.sh
```

The Linux bootstrap installer now keeps Salt optional by default even when `--salt-master` is provided. If a rollout must fail when Salt cannot be installed, pass `--require-salt` or set `ITMS_REQUIRE_SALT=true` explicitly.

The laptop and desktop refresh helper does not carry built-in credentials. Run it with an API bearer token, or supply login credentials plus an ingest token through flags or environment variables before using `--dry-run` or a live refresh.

```bash
python3 scripts/refresh-laptop-desktop-assets.py \
	--token "$ITMS_TOKEN" \
	--ingest-token "$ITMS_INGEST_TOKEN" \
	--dry-run
```

For SSH terminal access from the ITMS UI, prefer strict host key verification. Set `SSH_TERMINAL_USERNAME`, a private key path or inline key, `SSH_TERMINAL_KNOWN_HOSTS_PATH`, and keep `SSH_TERMINAL_STRICT_HOST_KEY=true`. Only disable strict host key checks temporarily while bootstrapping trusted host keys.

If a managed Linux endpoint is reachable through some other access method but ITMS SSH is blocked because the server key is not yet authorized, use the helper below on the endpoint to install the current ITMS public key for the target user and optionally restart `salt-minion`. Pass the key explicitly or provide it through `ITMS_AUTHORIZED_KEY` or `ITMS_AUTHORIZED_KEY_FILE`:

```bash
bash scripts/install-itms-ssh-key.sh zerodha-admin "$(cat /path/to/itms-ssh-key.pub)"
```

## Direct Compose Run

```bash
cd backend
cp .env.example .env
bash ../scripts/start-itms-backend.sh
```

The backend start helper auto-detects `docker compose` vs `docker-compose`, which matters on this host because the legacy standalone compose binary is still the working path.

## Backend Notes

- PostgreSQL is the source of truth for persistent data.
- Docker is used for runtime and service orchestration.
- Linux systems can push hardware and OS inventory directly to the backend with `scripts/push-system-inventory.py` and `INVENTORY_INGEST_TOKEN`.
- Linux hosts can self-bootstrap Ubuntu or Debian OpenSCAP content with `scripts/setup-itms-openscap-content.sh` and verify Salt, Wazuh, ClamAV, and OpenSCAP end to end with `scripts/verify-itms-security-integrations.sh`.
- A standalone scheduled OpenSCAP runner can be installed with `scripts/install-itms-openscap-runner.sh` when you want recurring scans without the full agent bootstrap.
- A non-root fallback timer can be installed with `scripts/install-itms-openscap-user-runner.sh` when `sudo` is unavailable, with the tradeoff that some OpenSCAP probes remain permission-limited.
- The current timer state and latest ingested OpenSCAP alert can be checked together with `scripts/check-itms-openscap-status.sh`.
- The full non-root deployment readiness suite can be run with `scripts/check-itms-release-readiness.sh`.
- Backend-specific setup details are documented in `backend/README.md`.
