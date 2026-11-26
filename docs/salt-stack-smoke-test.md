# Salt Stack Smoke Test Runbook

This runbook validates the local Salt patch stack (Salt master/API, two minions, Postgres, and Salt BFF).

## Prerequisites

- Docker Engine and Docker Compose are installed.
- Ports are available: `4100`, `4505`, `4506`, `5434`, `8001`.
- Run commands from repo root.

## 1) Start Stack

```bash
docker compose up -d --build --remove-orphans
```

Check service status:

```bash
docker compose ps
```

Expected:

- `salt-master` is `Up` with `8001->8000` published.
- `itms-ghani-salt-bff-1` is `Up` with `4100->4100` published.
- `minion-ubuntu` and `minion-rocky` are `Up`.
- `itms-ghani-postgres-1` is `Up`.

## 2) Initialize Database (idempotent)

```bash
cd backend/salt-bff
DATABASE_URL=postgres://postgres:postgres@localhost:5434/salt_console \
SALT_API_URL=http://localhost:8001 \
SALT_API_USER=salt \
SALT_API_PASSWORD=saltapi \
SALT_EAUTH=sharedsecret \
npm run db:migrate
```

## 3) Probe Salt API Login

```bash
curl -sS -X POST http://localhost:8001/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"salt","password":"saltapi","eauth":"sharedsecret"}'
```

Expected: JSON payload containing `return[0].token`.

## 4) Probe Salt BFF Health and Session

```bash
curl -sS http://localhost:4100/health
curl -sS -H 'x-user-email: admin@company.local' http://localhost:4100/api/session
```

Expected:

- `/health` returns `{ "ok": true }`.
- `/api/session` returns user/role/permissions.

## 5) Probe Minions and Compliance

```bash
curl -sS -H 'x-user-email: admin@company.local' http://localhost:4100/api/minions
curl -sS -H 'x-user-email: admin@company.local' http://localhost:4100/api/compliance
```

Expected:

- Two minions present: `minion-ubuntu`, `minion-rocky`.
- Compliance summary with `fleet` and `byDept` values.

## 6) Probe Run Dispatch

Use an allow-listed command from the BFF policy.

```bash
curl -sS -H 'x-user-email: admin@company.local' \
  -H 'Content-Type: application/json' \
  -X POST http://localhost:4100/api/runs \
  -d '{"fn":"cmd","scope":{"type":"all"},"arg":"echo smoke-ok","confirmed":true}'
```

Expected: JSON with a `jid` value.

## 7) Optional SSE Stream Check

```bash
curl -N -H 'x-user-email: admin@company.local' \
  http://localhost:4100/api/runs/<jid>/stream
```

Expected: server-sent events with `message`, `progress`, and `done`.

## Common Failures and Fixes

### A) `Client disabled: 'local'`

Cause: Salt netapi clients are not enabled.

Fix: Ensure `docker/salt/master/conf/master` includes:

- `netapi_enable_clients: [local, local_async, wheel, runner]`

Then restart:

```bash
docker compose restart salt-master salt-bff
```

### B) `503 Salt Master is not available`

Cause: Salt API cannot communicate with the master process.

Fix: Use the compose setup where `salt-master` runs both:

- `salt-master -d -l info`
- `salt-api -l info`

### C) Port collision on `8001`

Cause: stale/orphan container still binds `8001`.

Fix:

```bash
docker compose up -d --build --remove-orphans
```

### D) BFF `Empty reply from server` during `/api/runs`

Cause: unhandled route error in run path or invalid command string.

Fix:

- Use allow-listed command prefixes (`echo`, `apt`, `dnf`, etc.).
- Confirm BFF returns JSON error, not process crash.

## Teardown

```bash
docker compose down --remove-orphans
```
