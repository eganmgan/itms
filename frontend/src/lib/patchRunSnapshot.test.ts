import { describe, expect, it } from 'vitest'
import { buildPatchRunSnapshot, patchSnapshotLimitError } from './patchRunSnapshot'

const run = { scopeLabel: 'Departments: Engineering', requestedAt: '2026-09-16T10:00:00.000Z', completedAt: '2026-09-16T10:01:00.000Z', action: 'custom-state', state: 'patch.baseline', command: '' }
const devices = [{ id: 'db-id', assetTag: 'TAG-1', hostname: 'host-1', department: { name: 'Engineering' } }]

describe('patch run snapshots', () => {
  it('keeps failed raw results and extracts only actual target package changes, including partial failures', () => {
    const result = { return: [{ minion: {
      'pkg_|-updates': { result: false, changes: { openssl: { old: '1', new: '2' }, unchanged: { old: '1', new: '1' } }, stderr: 'partial failure', retcode: 7 },
      'file_|-config': { result: true, changes: { config: { old: 'a', new: 'b' } } },
      'pkg_|-preview': { result: null, changes: { preview: { old: '1', new: '2' } } },
    }, otherMinion: { 'pkg_|-other': { result: true, changes: { other: { old: '1', new: '2' } } } } }] }
    const item = { assetId: 'db-id', assetTag: 'ACTUAL-TAG', status: 'failed', error: 'state failed', result: { target: 'minion', action: 'custom-state', state: 'patch.baseline', historyRecorded: false, result } }
    const snapshot = buildPatchRunSnapshot({ targetCount: 1, results: [item] }, devices, run)
    expect(snapshot).toMatchObject({ scopeLabel: run.scopeLabel, requestedAt: run.requestedAt, completedAt: run.completedAt })
    expect(snapshot.rows[0]).toEqual({
      deviceId: 'db-id', assetTag: 'ACTUAL-TAG', hostname: 'host-1', department: 'Engineering', target: 'minion',
      status: 'failed', error: 'state failed', action: 'custom-state', command: '', state: 'patch.baseline',
      result, rawResult: item, updatedItems: ['openssl'], packageChanges: [{ name: 'openssl', fromVersion: '1', toVersion: '2' }],
    })
  })

  it('preserves command output, empty strings, zero codes and unknown metadata without inventing package updates', () => {
    const item = { assetId: 'db-id', status: 'completed', result: { target: 'minion', historyRecorded: true, result: { stdout: 'openssl upgraded (text is not package evidence)', stderr: '', output: '', retcode: 0, exitCode: 0, future: { value: 42 } } } }
    const [row] = buildPatchRunSnapshot({ targetCount: 1, results: [item] }, devices, { ...run, action: 'custom-command', state: '', command: 'uptime' }).rows
    expect(row).toMatchObject({ deviceId: 'db-id', assetTag: 'TAG-1', command: 'uptime', state: '', stdout: item.result.result.stdout, stderr: '', output: '', retcode: 0, exitCode: 0, rawResult: item, result: item.result.result })
    expect(row).not.toHaveProperty('updatedItems')
    expect(row).not.toHaveProperty('packageChanges')
    expect(row).not.toHaveProperty('error')
  })

  it('does not invent device metadata, outcomes or execution evidence for missing results', () => {
    for (const status of ['completed', 'queued', 'pending', 'skipped', 'unknown', 'failed']) {
      const item = { assetId: 'unknown-db-id', status }
      const [row] = buildPatchRunSnapshot({ targetCount: 1, results: [item] }, devices, run).rows
      expect(row).toEqual({ deviceId: item.assetId, status, action: run.action, command: '', state: run.state, rawResult: item })
    }
  })

  it('rejects empty reports or missing identities instead of silently dropping rows', () => {
    expect(() => buildPatchRunSnapshot({ targetCount: 0, results: [] }, devices, run)).toThrow('No device results')
    expect(() => buildPatchRunSnapshot({ targetCount: 1, results: [{ assetId: '', status: 'completed' }] }, devices, run)).toThrow('device ID')
  })

  it('checks row counts and UTF-8 byte limits without truncation', () => {
    const snapshot = buildPatchRunSnapshot({ targetCount: 1, results: [{ assetId: 'db-id', status: 'completed' }] }, devices, run)
    expect(patchSnapshotLimitError(snapshot)).toBe('')
    expect(patchSnapshotLimitError({ ...snapshot, rows: Array.from({ length: 501 }, () => snapshot.rows[0]) })).toContain('500 rows')
    const largeRow = { ...snapshot.rows[0], stdout: 'é'.repeat(132000) }
    expect(patchSnapshotLimitError({ ...snapshot, rows: [largeRow] })).toContain('256 KiB')
    const manyRows = Array.from({ length: 30 }, () => ({ ...snapshot.rows[0], stdout: 'x'.repeat(150000) }))
    expect(patchSnapshotLimitError({ ...snapshot, rows: manyRows })).toContain('4 MiB')
    expect(largeRow.stdout).toHaveLength(132000)
  })
})