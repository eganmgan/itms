type Data = Record<string, unknown>

export interface PatchBatchResult {
  targetCount: number
  results: Array<{ assetId: string; assetTag?: string; status: string; error?: string; result?: unknown } & Data>
}

interface SnapshotDevice {
  id: string
  assetTag?: string
  hostname: string
  department?: { name?: string }
}

export interface PatchRunSnapshot {
  scopeLabel: string
  requestedAt: string
  completedAt: string
  rows: Data[]
}

function object(value: unknown): Data {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}
}

// Only project version changes from actual pkg state returns. Other state changes,
// stdout, success labels and test-mode (null result) predictions are not inventory.
function packageEvidence(result: unknown, target: unknown) {
  const changes: Array<{ name: string; fromVersion: string; toVersion: string }> = []
  const returns = object(result).return
  if (!Array.isArray(returns) || typeof target !== 'string') return changes
  for (const entry of returns) {
    for (const [key, value] of Object.entries(object(object(entry)[target]))) {
      const state = object(value)
      if (!key.startsWith('pkg_|-') || typeof state.result !== 'boolean') continue
      for (const [name, versions] of Object.entries(object(state.changes))) {
        const { old, new: next } = object(versions)
        if (typeof old === 'string' && typeof next === 'string' && old !== next) {
          changes.push({ name, fromVersion: old, toVersion: next })
        }
      }
    }
  }
  return changes
}

export function buildPatchRunSnapshot(
  batch: PatchBatchResult,
  devices: SnapshotDevice[],
  run: { scopeLabel: string; requestedAt: string; completedAt: string; action: string; command: string; state: string },
): PatchRunSnapshot {
  if (!batch.results.length) throw new Error('No device results were returned; no report was submitted.')
  if (!run.scopeLabel.trim() || batch.results.some(item => typeof item.assetId !== 'string' || !item.assetId.trim())) {
    throw new Error('The response is missing a report scope or device ID; no report was submitted. Contact the API administrator with the execution output.')
  }
  return {
    scopeLabel: run.scopeLabel,
    requestedAt: run.requestedAt,
    completedAt: run.completedAt,
    // The server recalculates counts from statuses and recorded result evidence.
    rows: batch.results.map(item => {
      const device = devices.find(device => device.id === item.assetId)
      const envelope = object(item.result)
      const result = Object.hasOwn(envelope, 'result') ? envelope.result : item.result
      const row: Data = {
        deviceId: item.assetId,
        status: item.status,
        action: typeof envelope.action === 'string' ? envelope.action : run.action,
        command: typeof envelope.command === 'string' ? envelope.command : run.command,
        state: typeof envelope.state === 'string' ? envelope.state : run.state,
        rawResult: item,
      }
      const assetTag = item.assetTag || device?.assetTag
      if (assetTag) row.assetTag = assetTag
      if (device?.hostname) row.hostname = device.hostname
      if (device?.department?.name) row.department = device.department.name
      if (typeof envelope.target === 'string') row.target = envelope.target
      if (result !== undefined) row.result = result
      // Preserve empty strings and explicit zero codes, without conflating errors
      // with output or flattening/overwriting individual Salt state output.
      for (const source of [envelope, object(result), item]) {
        for (const key of ['output', 'stdout', 'stderr', 'error']) {
          if (typeof source[key] === 'string') row[key] = source[key]
        }
        for (const key of ['exitCode', 'retcode']) {
          if (Number.isInteger(source[key])) row[key] = source[key]
        }
      }
      const packageChanges = packageEvidence(result, envelope.target)
      if (packageChanges.length) {
        row.packageChanges = packageChanges
        row.updatedItems = [...new Set(packageChanges.map(change => change.name))]
      }
      return row
    }),
  }
}

export function patchSnapshotLimitError(snapshot: PatchRunSnapshot): string {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
  if (snapshot.rows.length > 500 || snapshot.rows.some(row => bytes(row) > 256 * 1024) || bytes(snapshot) > 4 * 1024 * 1024) {
    return 'Report exceeds the API limits (500 rows, 256 KiB per row, 4 MiB per request). Download the snapshot and explicitly split or reduce it before submitting through the report API; nothing was truncated.'
  }
  return ''
}