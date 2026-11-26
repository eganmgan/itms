import { describe, expect, it } from 'vitest'
import { executionLines, logStatistics, percentage, recordedLines, reportStatistics, type PatchLog, type PatchReport } from './patchReports'

describe('patch report data', () => {
  it('normalizes backend status aliases without changing recorded log values', () => {
    const logs = [' SUCCESS ', 'Completed', 'up_to_date', 'FAILED', ' error ', 'Failure', 'pending', 'cancelled', 'unknown'].map(status => ({ status })) as PatchLog[]
    expect(logStatistics(logs)).toEqual({ total: 9, successful: 3, failed: 3, other: 3, successPercentage: 33.3, failurePercentage: 33.3 })
    expect(logs[0].status).toBe(' SUCCESS ')
  })

  it('weights report percentages by target executions, preferring actual detail rows', () => {
    const reports = [
      { id: 'one', scopeLabel: 'One', rowCount: 100, rows: [{}, {}], successCount: 1, failedCount: 0 },
      { id: 'two', scopeLabel: 'Two', rowCount: 8, successCount: 2, failedCount: 4 },
    ] satisfies PatchReport[]
    expect(reportStatistics(reports)).toEqual({ total: 10, successful: 3, failed: 4, other: 3, successPercentage: 30, failurePercentage: 40 })
    expect(percentage(0, 0)).toBe(0)
  })

  it('keeps pending/unknown executions separate from successes and failures', () => {
    const logs = ['success', 'failed', 'pending', 'skipped'].map(status => ({ status })) as PatchLog[]
    expect(logStatistics(logs)).toEqual({ total: 4, successful: 1, failed: 1, other: 2, successPercentage: 25, failurePercentage: 25 })
    expect(percentage(0, 0)).toBe(0)
    expect(reportStatistics([]).successPercentage).toBe(0)
  })
  it('preserves nested execution output and explicit zero exit codes', () => {
    expect(executionLines({ target: 'host', status: 'completed', result: { stdout: 'actual output', stderr: '', retcode: 0, pid: 4127 } })).toEqual(['host: COMPLETED', 'Exit code: 0 · PID: 4127', 'stdout: actual output', 'stderr: '])
    expect(recordedLines({ changes: [], value: null, other: {} })).toEqual(['changes: []', 'value: Not recorded', 'other: {}'])
  })
})