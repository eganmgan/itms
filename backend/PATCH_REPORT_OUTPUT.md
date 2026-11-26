# Patch execution reporting contract

## Report snapshots

`POST /api/patch/reports` keeps the existing scope, timestamps, entity checks,
device rows, `updatedItems`, and `packageChanges` contract. Each row additionally
accepts `assetTag`, `command`, `state`, `output`, `stdout`, `stderr`, `error`,
`exitCode`, `retcode`, `result`, and `rawResult`.

- Output/error fields are optional strings. Explicit empty strings are retained.
- Exit codes are optional integers. Zero is retained; omission is not treated as
  exit code zero. Nonzero row exit codes override a claimed successful status.
- `result` and `rawResult` are opaque JSON values. Unknown nested fields are
  retained, including precise JSON numbers on report detail reads. Known direct
  command and Salt state result shapes in `result` inform status normalization.
- Unknown top-level row fields are not part of this contract; put agent-specific
  metadata inside `result` or `rawResult`.
- Limits are 4 MiB for the request body, 500 rows, and 256 KiB for each serialized
  row (including output, raw results, and package changes). Oversized submissions
  return HTTP 400; data is never silently truncated. Large submissions must be
  explicitly split or reduced by the caller before retrying.
- Counts are recalculated: `success`, `completed`, and `up_to_date` are successful;
  `failed`, `error`, and `failure` are failures. Case/whitespace are normalized.
  Running, queued, pending, skipped, cancelled, and unknown outcomes count as
  neither success nor failure. A null Salt state result is pending, not success.

The existing JSONB report storage needs no migration. Reports are caller-submitted
snapshots, not independently verified package inventories. Missing output and
package changes are not synthesized, and older stored reports are not backfilled.

## Execution history

Every `queuePatchRun` attempt writes `patch_run` history, including missing
integration/minion, connectivity, validation, transport, and state failures.
State execution failures retain the returned Salt result alongside the error,
including partial package changes and actual stdout/stderr/retcodes. Errors are
not relabeled as execution output. Batch failures retain this result envelope.
The response's `historyRecorded` flag indicates whether the history write
succeeded; a database failure does not imply the remote operation failed.

## Frontend integration

The batch console now POSTs a snapshot to `/api/patch/reports` after receiving a
batch response, including responses with failed or pending device rows. The scope,
command/state and device metadata are captured for that request; `requestedAt`
and `completedAt` are client-observed batch request/response times, not invented
per-device execution times or report-save times. Each row uses the returned
database asset ID as `deviceId`, the returned asset tag (with directory fallback),
and available directory hostname/department. The returned execution target is
kept separately; a hostname or asset tag is never substituted for a database ID.

`result` contains the underlying Salt result for backend outcome normalization;
`rawResult` retains the complete batch row, including the execution envelope,
errors, unknown metadata and `historyRecorded`. Direct output/error strings,
including empty strings, and explicit integer exit codes are preserved. Nested
state output remains in the result rather than being flattened into a misleading
single stdout or exit code. No execution output, current patch status, package
inventory or update list is inferred from success. Package summaries include only
recorded, differing string `old`/`new` versions in the executed target's `pkg`
state changes, including partial failures; null/test-mode predictions and unrelated
state changes are excluded. Other evidence remains available in the raw result.
Report detail and CSV/JSON/PDF consumers traverse these recorded fields.

Report persistence has separate status/error UI and never replaces execution
output. Failed saves retain the snapshot in page memory with a save-only retry
and JSON download; retry does not call the batch endpoint again or change its
timestamps. For ambiguous network failures, check Reports before retrying because
the endpoint does not provide idempotency. Download before leaving/reloading the
page, changing accounts or starting another run to retain an unsaved snapshot.
Empty results or missing device IDs are not submitted. The frontend checks the
500-row, 256-KiB-per-row and 4-MiB request limits, without truncation; oversized
snapshots remain downloadable for explicit splitting/reduction and report-only
submission. Backend validation remains authoritative, and HTTP/transport failures
are surfaced separately from remote execution failures. Nothing backfills missing
historical output or requires rerunning a remote operation just to save a report.

## SSH startup

SSH startup uses a single 15-second budget across TCP dialing, authentication
username fallback, session channel creation, PTY, and shell requests. An earlier
request deadline/cancellation wins. Failure closes the underlying transport first
to unblock SSH operations. Successful handoff stops the cancellation watcher and
clears the socket deadline so an interactive session can outlive startup.
The configured known-hosts/strict-host-key policy is unchanged.

Socket deadlines may fire before the context timer is scheduled; startup checks
the deadline timestamp as well as `ctx.Err()` before retrying or handing off.
Regression tests cover each stalled stage, cancellation, host-key rejection,
shared authentication retry deadlines, and successful post-deadline I/O.
