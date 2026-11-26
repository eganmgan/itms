import { exportCsv, exportElementPdf, exportJson } from './exports'

export type RecordedData = Record<string, unknown>
export interface PatchLog extends RecordedData {
  id: string; assetId?: string; assetTag?: string; hostname: string; department: string;
  status: string; createdAt: string; action?: string; actor?: string; detail?: RecordedData
}
export interface PatchReport extends RecordedData {
  id: string; scopeLabel: string; successCount: number; failedCount: number; rowCount?: number;
  rows?: RecordedData[]
}
export const reportingBrand = 'Zerodha ITMS Reporting System'

export function percentage(count: number, total: number) {
  return total > 0 ? Math.round(count / total * 1000) / 10 : 0
}

export function logStatistics(logs: PatchLog[]) {
  const statuses = logs.map(item => item.status.trim().toLowerCase())
  const successful = statuses.filter(status => ['success', 'completed', 'up_to_date'].includes(status)).length
  const failed = statuses.filter(status => ['failed', 'error', 'failure'].includes(status)).length
  return statistics(logs.length, successful, failed)
}

export function statistics(total: number, successful: number, failed: number) {
  return { total, successful, failed, other: Math.max(0, total - successful - failed), successPercentage: percentage(successful, total), failurePercentage: percentage(failed, total) }
}

export function reportStatistics(reports: PatchReport[]) {
  return statistics(reports.reduce((sum, item) => sum + (item.rows?.length ?? item.rowCount ?? 0), 0), reports.reduce((sum, item) => sum + item.successCount, 0), reports.reduce((sum, item) => sum + item.failedCount, 0))
}

// Do not whitelist recorded fields: older and newer agents return different result shapes.
export function recordedLines(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [`${prefix ? `${prefix}: ` : ''}${String(value ?? 'Not recorded')}`]
  const entries = Object.entries(value)
  if (!entries.length) return [`${prefix}: ${Array.isArray(value) ? '[]' : '{}'}`]
  return entries.flatMap(([key, child]) => recordedLines(child, prefix ? `${prefix}.${key}` : key))
}

export function executionLines(value: unknown): string[] {
  if (!value || typeof value !== 'object') return value == null ? [] : [String(value)]
  const data = value as RecordedData
  const lines: string[] = []
  if (typeof data.target === 'string') lines.push(`${data.target}: ${String(data.status ?? 'recorded').toUpperCase()}`)
  if (data.retcode !== undefined || data.pid !== undefined) lines.push([data.retcode !== undefined ? `Exit code: ${data.retcode}` : '', data.pid !== undefined ? `PID: ${data.pid}` : ''].filter(Boolean).join(' · '))
  for (const [key, child] of Object.entries(data)) {
    if (['retcode', 'pid', 'target', 'status'].includes(key)) continue
    if (key === 'result') lines.push(...executionLines(child))
    else lines.push(...recordedLines(child, key))
  }
  return lines
}

export type ExportFormat = 'csv' | 'json' | 'pdf'

export function patchExportPayload(title: string, records: RecordedData[], summary: ReturnType<typeof statistics>) {
  return { reportingSystem: reportingBrand, title, generatedAt: new Date().toISOString(), summary, records }
}

export async function downloadPatchRecords(format: ExportFormat, filename: string, payload: ReturnType<typeof patchExportPayload>) {
  const safeFilename = filename.replace(/[^a-zA-Z0-9_-]/g, '-')
  if (format === 'json') return exportJson(`${safeFilename}.json`, payload)
  if (format === 'csv') {
    // A path/value representation retains every recorded field, including nested package changes,
    // stdout/stderr, unknown future fields, and explicit empty values, without lossy projections.
    const rows: Array<Array<string | number>> = [['Record', 'Field', 'Value']]
    const append = (value: unknown, path: string, record: string) => {
      if (value !== null && typeof value === 'object' && Object.keys(value).length) {
        Object.entries(value).forEach(([key, child]) => append(child, path ? `${path}.${key}` : key, record))
      } else rows.push([record, path, typeof value === 'string' ? value : JSON.stringify(value) ?? ''])
    }
    append(payload.reportingSystem, 'reportingSystem', 'metadata')
    append(payload.title, 'title', 'metadata')
    append(payload.generatedAt, 'generatedAt', 'metadata')
    append(payload.summary, 'summary', 'metadata')
    payload.records.forEach((record, index) => append(record, '', String(index + 1)))
    return exportCsv(`${safeFilename}.csv`, rows)
  }
  const element = document.createElement('section')
  element.style.cssText = 'color:#172b4d;background:white;font-family:Arial,sans-serif;padding:24px;width:700px;'
  const heading = document.createElement('h1')
  heading.textContent = reportingBrand
  heading.style.cssText = 'color:#387ed1;font-size:24px;border-bottom:3px solid #387ed1;padding-bottom:12px;'
  element.append(heading)
  const title = document.createElement('h2')
  title.textContent = payload.title
  element.append(title)
  const summary = document.createElement('p')
  summary.textContent = `Generated: ${payload.generatedAt} · Recorded targets: ${payload.summary.total} · Success: ${payload.summary.successPercentage}% · Failed: ${payload.summary.failurePercentage}% · Other: ${payload.summary.other}`
  element.append(summary)
  for (const record of payload.records) {
    const label = document.createElement('h3')
    label.textContent = String(record.assetTag || record.scopeLabel || record.hostname || record.id || 'Recorded execution')
    element.append(label)
    const output = document.createElement('pre')
    output.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font-size:10px;line-height:1.5;'
    output.textContent = recordedLines(record).join('\n')
    element.append(output)
  }
  await exportElementPdf(element, `${safeFilename}.pdf`)
}