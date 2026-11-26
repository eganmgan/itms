# ITMS Local Verification Checklist

Date: 2026-07-10

Use this checklist when you want to "check all files and try" before release or handoff.

## Prerequisites

- Working directory: repository root.
- Frontend dependencies installed (`frontend/node_modules` exists).
- Backend service reachable on `http://localhost:3001` (or set `API_BASE_URL`).

## 1) Workspace Diagnostics

Run editor diagnostics first (Problems panel or Copilot diagnostics tool) and resolve blocking errors.

## 2) Frontend Validation

```bash
cd frontend
npm run lint
npm test
npm run build
```

Expected outcome:

- Lint passes.
- Test suite passes.
- Build completes and outputs `frontend/dist`.

## 3) Backend Runtime Health

```bash
cd ..
curl -sS http://localhost:3001/api/health
```

Expected outcome:

- JSON includes `"status":"ok"` and `"database":"up"`.

## 4) Backend API Smoke Test

```bash
cd ..
bash scripts/smoke-test-itms-api.sh
```

Notes:

- The smoke script requires valid admin credentials.
- If login returns `401`, update local admin credentials (or set the correct credentials in backend env/secrets) and rerun.

## 5) Backend Compile/Test (when tooling exists)

If `go` is installed:

```bash
cd backend
go test ./...
```

If `go` is not installed, treat backend compile/test as pending and document that gap explicitly.

## 6) Git State

```bash
cd ..
git status -sb
git log --oneline -5
```

Expected outcome:

- Branch clean or only intended changes.
- Latest commits match expected release scope.

## Quick Summary Template

- Frontend lint: pass/fail
- Frontend tests: pass/fail (files/tests count)
- Frontend build: pass/fail
- Backend health endpoint: pass/fail
- Backend smoke test: pass/fail/blocked (reason)
- Backend compile/test: pass/fail/blocked (reason)
- Git sync status: synced/diverged