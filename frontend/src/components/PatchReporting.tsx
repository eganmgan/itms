import { useState } from 'react'
import { downloadPatchRecords, logStatistics, patchExportPayload, percentage, recordedLines, reportingBrand, reportStatistics, type ExportFormat, type PatchLog, type PatchReport } from '../lib/patchReports'

const formats: ExportFormat[] = ['csv', 'json', 'pdf']

export function PatchResultsSummary({ rows }: { rows: Record<string, unknown>[] }) {
  return <section aria-label="Update results by hostname" className="min-w-0 space-y-3">
    <h3 className="text-sm font-bold">Update results by hostname</h3>
    <div className="min-w-0 overflow-x-auto"><table className="data-table [&_td]:align-top">
      <thead className="border-y"><tr><th>Hostname</th><th>Status</th><th>Recorded package changes / error</th></tr></thead>
      <tbody className="divide-y">{rows.map((row, index) => {
        const changes = Array.isArray(row.packageChanges) ? row.packageChanges.filter((change): change is { name: string; fromVersion: string; toVersion: string } => Boolean(change && typeof change === 'object' && typeof change.name === 'string' && typeof change.fromVersion === 'string' && typeof change.toVersion === 'string')) : []
        const hostname = typeof row.hostname === 'string' && row.hostname ? row.hostname : typeof row.target === 'string' && row.target ? row.target : 'Hostname not recorded'
        return <tr key={index}>
          <td><strong>{hostname}</strong>{typeof row.assetTag === 'string' && <p className="mt-1 text-slate-500">{row.assetTag}</p>}</td>
          <td className="whitespace-nowrap">{typeof row.status === 'string' ? row.status : 'Not recorded'}</td>
          <td>{changes.length ? <ul className="space-y-2">{changes.map((change, changeIndex) => <li key={changeIndex}><strong>{change.name}</strong><p>{change.fromVersion || 'Not installed'}{' -> '}{change.toVersion || 'Removed'}</p></li>)}</ul> : <p>No package changes recorded.</p>}{typeof row.error === 'string' && row.error && <p className="mt-2 text-rose-700 dark:text-rose-300">{row.error}</p>}</td>
        </tr>
      })}</tbody>
    </table></div>
  </section>
}

function DownloadButtons({ label, busy, onDownload }: { label?: string; busy?: boolean; onDownload: (format: ExportFormat) => void }) {
  return <div className="flex gap-2">{formats.map(format => <button key={format} className="secondary-button" disabled={busy} aria-label={label ? `Download ${label} ${format.toUpperCase()}` : undefined} onClick={() => onDownload(format)}>{format.toUpperCase()}</button>)}</div>
}

export function PatchLogsPanel({ logs }: { logs: PatchLog[] }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const summary = logStatistics(logs)
  async function download(format: ExportFormat, item?: PatchLog) {
    setError(''); setBusy(true)
    const records = item ? [item] : logs
    try { await downloadPatchRecords(format, item ? `itms-patch-log-${item.id}` : 'itms-patch-logs', patchExportPayload(item ? `Patch execution ${item.id}` : 'Patch execution logs', records, logStatistics(records))) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Download failed') }
    finally { setBusy(false) }
  }
  return <section className="space-y-4">
    <div className="card flex flex-wrap items-center justify-between gap-4 p-4"><div><h2 className="font-bold">Patch execution logs</h2><p>Success <strong>{summary.successPercentage}%</strong> · Failed <strong>{summary.failurePercentage}%</strong> · {summary.total} recorded executions · {summary.other} other</p></div><DownloadButtons busy={busy || !logs.length} onDownload={format => void download(format)} /></div>
    {error && <p role="alert">{error}</p>}
    <div className="table-shell overflow-x-auto"><table className="data-table"><thead><tr>{['Time', 'System', 'Department', 'Status', 'Downloads'].map(heading => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{logs.map(item => <tr key={item.id}><td>{new Date(item.createdAt).toLocaleString()}</td><td><strong>{item.assetTag || 'Asset tag not recorded'}</strong><p>{item.hostname}</p></td><td>{item.department}</td><td>{item.status}</td><td><DownloadButtons busy={busy} label={`log ${item.id}`} onDownload={format => void download(format, item)} /></td></tr>)}{!logs.length && <tr><td colSpan={5}>No patch executions recorded yet.</td></tr>}</tbody></table></div>
    <p className="text-xs text-slate-500">Percentages use the loaded recorded executions, not package completion or all-time history. The API returns up to 200 recent logs. Each log download contains only that execution and its recorded detail.</p>
  </section>
}

export function PatchReportsPanel({ reports, loadDetail }: { reports: PatchReport[]; loadDetail: (id: string) => Promise<PatchReport> }) {
  const [detail, setDetail] = useState<PatchReport | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const summary = reportStatistics(reports)
  async function fullDetail(item: PatchReport) {
    const report = await loadDetail(item.id)
    if (!report || report.id !== item.id || !Array.isArray(report.rows) || !report.rows.length || report.rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error('Report detail is incomplete; no full report can be displayed or downloaded. Retry the detail request.')
    }
    // Keep list-only metadata, but use the freshly authorized rows and counts.
    return { ...item, ...report, rowCount: report.rows.length }
  }
  async function view(item: PatchReport) {
    setBusy(true); setError(''); setDetail(null)
    try { setDetail(await fullDetail(item)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Report detail unavailable') }
    finally { setBusy(false) }
  }
  async function download(format: ExportFormat, item?: PatchReport) {
    setBusy(true); setError('')
    try {
      // Always re-authorize detail reads. Never export summary-only data as a full report.
      const details = await Promise.all((item ? [item] : reports).map(fullDetail))
      await downloadPatchRecords(format, item ? `itms-patch-report-${item.id}` : 'itms-patch-reports', patchExportPayload(item?.scopeLabel || 'Patch execution reports', details, reportStatistics(details)))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Report download failed') }
    finally { setBusy(false) }
  }
  return <section className="card space-y-5 p-6">
    <header className="flex flex-wrap justify-between gap-4"><div><h2 className="text-lg font-extrabold text-brand-600">{reportingBrand}</h2><p>Patch execution reports · Recorded packages, actions and execution output</p></div><DownloadButtons busy={busy || !reports.length} onDownload={format => void download(format)} /></header>
    <p>{reports.length} reports · {summary.total} targets · Success <strong>{summary.successPercentage}%</strong> · Failed <strong>{summary.failurePercentage}%</strong> · {summary.other} other</p>
    <p className="text-xs text-slate-500">Percentages count target executions across loaded reports, not unique devices or package completion. The API returns up to 50 recent reports by default; bulk downloads include only the loaded reports. Reports are submitted snapshots, not independently verified inventories.</p>
    {error && <p role="alert" className="text-rose-700">{error}</p>}
    {busy && <p role="status">Loading report…</p>}
    <div className="overflow-x-auto"><table className="data-table"><thead><tr>{['Scope', 'Targets', 'Successful', 'Failed', 'Success rate', 'Failure rate', 'Actions'].map(heading => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{reports.map(item => <tr key={item.id}><td>{item.scopeLabel}</td><td>{item.rows?.length ?? item.rowCount ?? 0}</td><td>{item.successCount}</td><td>{item.failedCount}</td><td>{percentage(item.successCount, item.rows?.length ?? item.rowCount ?? 0)}%</td><td>{percentage(item.failedCount, item.rows?.length ?? item.rowCount ?? 0)}%</td><td><div className="flex flex-wrap gap-2"><button className="secondary-button" disabled={busy} onClick={() => void view(item)} aria-label={`View report ${item.id}`}>View details</button><DownloadButtons busy={busy} label={`report ${item.id}`} onDownload={format => void download(format, item)} /></div></td></tr>)}</tbody></table></div>
    {!reports.length && <p>No patch reports recorded yet.</p>}
    {detail && <article aria-label="Report detail" className="space-y-3 border-t pt-4"><h3 className="font-bold">{detail.scopeLabel}</h3><PatchResultsSummary rows={detail.rows || []} /><p>Updated packages, actions and stdout/stderr/output below are recorded values. Missing fields were not recorded; no output is inferred.</p><pre className="whitespace-pre-wrap break-words rounded bg-slate-50 p-4 text-xs dark:bg-slate-950">{recordedLines(detail).join('\n')}</pre></article>}
  </section>
}