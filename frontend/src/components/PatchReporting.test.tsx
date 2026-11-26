import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PatchLogsPanel, PatchReportsPanel, PatchResultsSummary } from './PatchReporting'
import { exportCsv, exportElementPdf, exportJson } from '../lib/exports'
import type { PatchLog, PatchReport } from '../lib/patchReports'

vi.mock('../lib/exports', () => ({ exportCsv: vi.fn(), exportJson: vi.fn(), exportElementPdf: vi.fn().mockResolvedValue(undefined) }))

const logs: PatchLog[] = [
  { id: 'log-1', assetId: 'asset-1', assetTag: 'ZR-1001', hostname: 'host-1', department: 'Engineering', status: 'success', createdAt: '2026-09-16T05:00:00Z', detail: { action: 'system-update', updatedItems: ['openssl'], packageChanges: [{ name: 'openssl', fromVersion: '3.0.1', toVersion: '3.0.2' }], result: { stdout: 'Updated openssl\nDone', stderr: '', retcode: 0 }, futureField: { retained: true } } },
  { id: 'log-2', assetId: 'asset-2', assetTag: 'ZBL-2001', hostname: 'host-2', department: 'Finance', status: 'failed', createdAt: '2026-09-16T06:00:00Z', detail: { action: 'custom-command', command: 'uptime', output: '<script>untrusted()</script>', stderr: 'Connection lost', retcode: 1 } },
]
const report: PatchReport = { id: 'report-1', scopeLabel: 'Engineering rollout', successCount: 1, failedCount: 1, rowCount: 2, requestedAt: '2026-09-16T05:00:00Z', completedAt: '2026-09-16T06:00:00Z' }
const detail: PatchReport = { ...report, rows: logs.map(log => ({ deviceId: log.assetId, assetTag: log.assetTag, hostname: log.hostname, status: log.status, ...log.detail })), agentMetadata: { version: '2.0', exact: true } }

describe('patch reporting interactions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('distinguishes recorded installs and removals from successful commands without package evidence', () => {
    render(<PatchResultsSummary rows={[
      { hostname: 'changed-host', status: 'completed', packageChanges: [{ name: 'new-package', fromVersion: '', toVersion: '1.0' }, { name: 'old-package', fromVersion: '2.0', toVersion: '' }] },
      { status: 'completed', stdout: 'Updated openssl', packageChanges: [null, 'invalid', { name: 'invented' }] },
    ]} />)
    const rows = screen.getAllByRole('row')
    expect(rows[1]).toHaveTextContent('Not installed -> 1.0')
    expect(rows[1]).toHaveTextContent('2.0 -> Removed')
    expect(rows[2]).toHaveTextContent('Hostname not recordedcompletedNo package changes recorded.')
    expect(rows[2]).not.toHaveTextContent('openssl')
    expect(rows[2]).not.toHaveTextContent('invented')
  })

  it.each(logs.map(log => [log.id, log] as const))('downloads only %s as JSON with full detail and its own percentages', async (id, log) => {
    render(<PatchLogsPanel logs={logs} />)
    fireEvent.click(screen.getByRole('button', { name: `Download log ${id} JSON` }))
    await waitFor(() => expect(exportJson).toHaveBeenCalledOnce())
    expect(exportJson).toHaveBeenCalledWith(`itms-patch-log-${id}.json`, expect.objectContaining({ reportingSystem: 'Zerodha ITMS Reporting System', records: [log], summary: expect.objectContaining({ total: 1, successPercentage: log.status === 'success' ? 100 : 0, failurePercentage: log.status === 'failed' ? 100 : 0 }) }))
  })

  it.each(logs.map(log => [log.id, log] as const))('downloads %s CSV with recorded nested output, packages and percentages', async (id, log) => {
    render(<PatchLogsPanel logs={logs} />)
    fireEvent.click(screen.getByRole('button', { name: `Download log ${id} CSV` }))
    await waitFor(() => expect(exportCsv).toHaveBeenCalledOnce())
    const [filename, rows] = vi.mocked(exportCsv).mock.calls[0]
    expect(filename).toBe(`itms-patch-log-${id}.csv`)
    expect(rows).toContainEqual(['1', 'assetTag', log.assetTag])
    expect(rows).toContainEqual(['metadata', 'summary.successPercentage', log.status === 'success' ? '100' : '0'])
    if (id === 'log-1') {
      expect(rows).toContainEqual(['1', 'detail.packageChanges.0.fromVersion', '3.0.1'])
      expect(rows).toContainEqual(['1', 'detail.result.stdout', 'Updated openssl\nDone'])
      expect(rows).toContainEqual(['1', 'detail.result.stderr', ''])
      expect(rows).toContainEqual(['1', 'detail.futureField.retained', 'true'])
    } else {
      expect(rows).toContainEqual(['1', 'detail.stderr', 'Connection lost'])
      expect(rows).toContainEqual(['1', 'detail.output', '<script>untrusted()</script>'])
    }
    expect(JSON.stringify(rows)).not.toContain(logs.find(item => item.id !== id)?.assetTag)
  })

  it.each(logs.map(log => [log.id, log] as const))('downloads %s as branded PDF with recorded content only', async (id, log) => {
    render(<PatchLogsPanel logs={logs} />)
    fireEvent.click(screen.getByRole('button', { name: `Download log ${id} PDF` }))
    await waitFor(() => expect(exportElementPdf).toHaveBeenCalledOnce())
    const [element, filename] = vi.mocked(exportElementPdf).mock.calls[0]
    expect(filename).toBe(`itms-patch-log-${id}.pdf`)
    expect(element.textContent).toContain('Zerodha ITMS Reporting System')
    expect(element.textContent).toContain(`Success: ${log.status === 'success' ? 100 : 0}%`)
    expect(element.textContent).toContain(log.assetTag)
    expect(element.textContent).not.toContain(logs.find(item => item.id !== id)?.assetTag)
    expect(element.querySelector('script')).toBeNull()
    expect(element.textContent).toContain(id === 'log-1' ? 'Updated openssl\nDone' : '<script>untrusted()</script>')
  })

  it('shows actual report packages, versions, actions, stdout/stderr and extra recorded fields', async () => {
    const loadDetail = vi.fn().mockResolvedValue(detail)
    render(<PatchReportsPanel reports={[report]} loadDetail={loadDetail} />)
    expect(loadDetail).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'View report report-1' }))
    const article = await screen.findByRole('article', { name: 'Report detail' })
    expect(loadDetail).toHaveBeenCalledWith('report-1')
    const summary = within(article).getByRole('region', { name: 'Update results by hostname' })
    expect(summary).toHaveTextContent('host-1')
    expect(summary).toHaveTextContent('3.0.1 -> 3.0.2')
    for (const value of ['openssl', '3.0.1', '3.0.2', 'system-update', 'stdout', 'stderr', 'Updated openssl', 'Connection lost', 'custom-command', 'output', 'agentMetadata.version: 2.0']) expect(article).toHaveTextContent(value)
  })

  it.each(['CSV', 'JSON', 'PDF'])('fetches and downloads full report detail as %s rather than the summary', async format => {
    const loadDetail = vi.fn().mockResolvedValue(detail)
    render(<PatchReportsPanel reports={[report]} loadDetail={loadDetail} />)
    fireEvent.click(screen.getByRole('button', { name: `Download report report-1 ${format}` }))
    await waitFor(() => expect(loadDetail).toHaveBeenCalledWith('report-1'))
    if (format === 'JSON') {
      await waitFor(() => expect(exportJson).toHaveBeenCalledOnce())
      expect(exportJson).toHaveBeenCalledWith('itms-patch-report-report-1.json', expect.objectContaining({ records: [detail], summary: expect.objectContaining({ successPercentage: 50, failurePercentage: 50 }) }))
    } else if (format === 'CSV') {
      await waitFor(() => expect(exportCsv).toHaveBeenCalledOnce())
      const rows = vi.mocked(exportCsv).mock.calls[0][1]
      expect(rows).toContainEqual(['1', 'rows.0.packageChanges.0.toVersion', '3.0.2'])
      expect(rows).toContainEqual(['1', 'rows.1.stderr', 'Connection lost'])
      expect(rows).toContainEqual(['1', 'agentMetadata.exact', 'true'])
    } else {
      await waitFor(() => expect(exportElementPdf).toHaveBeenCalledOnce())
      const element = vi.mocked(exportElementPdf).mock.calls[0][0]
      for (const text of ['Zerodha ITMS Reporting System', 'openssl', 'Connection lost', 'Updated openssl', 'Success: 50%', 'Failed: 50%']) expect(element.textContent).toContain(text)
    }
  })

  it('does not download a summary or invented output if report detail is forbidden', async () => {
    render(<PatchReportsPanel reports={[report]} loadDetail={vi.fn().mockRejectedValue(new Error('forbidden'))} />)
    fireEvent.click(screen.getByRole('button', { name: 'Download report report-1 JSON' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('forbidden')
    expect(exportJson).not.toHaveBeenCalled()
    expect(exportCsv).not.toHaveBeenCalled()
    expect(exportElementPdf).not.toHaveBeenCalled()
  })

  it.each(['CSV', 'JSON', 'PDF'])('rejects a successful summary-only response for %s downloads', async format => {
    render(<PatchReportsPanel reports={[report]} loadDetail={vi.fn().mockResolvedValue(report)} />)
    fireEvent.click(screen.getByRole('button', { name: `Download report report-1 ${format}` }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Report detail is incomplete')
    expect(exportJson).not.toHaveBeenCalled()
    expect(exportCsv).not.toHaveBeenCalled()
    expect(exportElementPdf).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: `Download report report-1 ${format}` })).toBeEnabled()
  })

  it.each([undefined, [], [null], ['not a row']])('refuses incomplete rows in the detail viewer: %j', async rows => {
    render(<PatchReportsPanel reports={[report]} loadDetail={vi.fn().mockResolvedValue({ ...detail, rows })} />)
    fireEvent.click(screen.getByRole('button', { name: 'View report report-1' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Report detail is incomplete')
    expect(screen.queryByRole('article', { name: 'Report detail' })).not.toBeInTheDocument()
  })

  it('rejects detail for the wrong report', async () => {
    render(<PatchReportsPanel reports={[report]} loadDetail={vi.fn().mockResolvedValue({ ...detail, id: 'another-report' })} />)
    fireEvent.click(screen.getByRole('button', { name: 'Download report report-1 JSON' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Report detail is incomplete')
    expect(exportJson).not.toHaveBeenCalled()
  })

  it('exports fresh detail counts and rows rather than stale list totals', async () => {
    const stale = { ...report, rowCount: 20, successCount: 20, failedCount: 0, requestedBy: 'Recorded operator' }
    const { rowCount: _rowCount, ...apiDetail } = detail
    render(<PatchReportsPanel reports={[stale]} loadDetail={vi.fn().mockResolvedValue(apiDetail)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Download report report-1 JSON' }))
    await waitFor(() => expect(exportJson).toHaveBeenCalledOnce())
    expect(exportJson).toHaveBeenCalledWith('itms-patch-report-report-1.json', expect.objectContaining({
      records: [{ ...detail, requestedBy: 'Recorded operator' }],
      summary: expect.objectContaining({ total: 2, successPercentage: 50, failurePercentage: 50 }),
    }))
  })

  it.each(['CSV', 'JSON', 'PDF'])('exports every loaded report with complete detail as %s', async format => {
    const other = { ...report, id: 'report-2', scopeLabel: 'Other rollout' }
    const otherDetail = { ...detail, ...other }
    const loadDetail = vi.fn().mockImplementation((id: string) => Promise.resolve(id === report.id ? detail : otherDetail))
    render(<PatchReportsPanel reports={[report, other]} loadDetail={loadDetail} />)
    fireEvent.click(screen.getByRole('button', { name: format }))
    const exporter = format === 'CSV' ? exportCsv : format === 'JSON' ? exportJson : exportElementPdf
    await waitFor(() => expect(exporter).toHaveBeenCalledOnce())
    expect(loadDetail).toHaveBeenCalledTimes(2)
    if (format === 'JSON') expect(vi.mocked(exportJson).mock.calls[0][1]).toMatchObject({ records: [detail, otherDetail], summary: { total: 4, successPercentage: 50, failurePercentage: 50 } })
    else if (format === 'CSV') expect(vi.mocked(exportCsv).mock.calls[0][1]).toContainEqual(['2', 'rows.0.result.stdout', 'Updated openssl\nDone'])
    else expect(vi.mocked(exportElementPdf).mock.calls[0][0].textContent).toContain('Other rollout')
  })

  it('surfaces PDF failures and permits a download retry', async () => {
    vi.mocked(exportElementPdf).mockRejectedValueOnce(new Error('PDF generation failed'))
    render(<PatchLogsPanel logs={logs} />)
    fireEvent.click(screen.getByRole('button', { name: 'Download log log-1 PDF' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('PDF generation failed')
    fireEvent.click(screen.getByRole('button', { name: 'Download log log-1 PDF' }))
    await waitFor(() => expect(exportElementPdf).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('exports all reports only after every detail request succeeds', async () => {
    const other = { ...report, id: 'report-2' }
    const loadDetail = vi.fn().mockImplementation((id: string) => id === 'report-1' ? Promise.resolve(detail) : Promise.reject(new Error('Report unavailable')))
    render(<PatchReportsPanel reports={[report, other]} loadDetail={loadDetail} />)
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Report unavailable')
    expect(loadDetail).toHaveBeenCalledTimes(2)
    expect(exportJson).not.toHaveBeenCalled()
  })
})