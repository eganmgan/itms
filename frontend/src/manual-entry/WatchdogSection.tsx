import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, ArrowUpRight, CheckCircle2, CircleHelp, RefreshCw, Search } from 'lucide-react'
import { accessFailure, adminRequest } from '../admin-computers/api'
import { getToken, subscribeAuth } from '../lib/auth'
import { browserFailures } from '../lib/browserFailures'
import type { SessionProps } from './api'

type Status = 'ok' | 'warning' | 'error' | 'unknown'
type Check = { id: string; name: string; status: Status; detail: string; action: string; href: string }
type Report = { checkedAt: string; status: Status; checks: Check[] }
const labels: Record<Status, string> = { ok: 'Passed', warning: 'Attention', error: 'Error', unknown: 'Not verified' }
const tones: Record<Status, string> = { ok: 'text-emerald-700', warning: 'text-amber-700', error: 'text-rose-700', unknown: 'text-slate-500' }
const icons = { ok: CheckCircle2, warning: AlertTriangle, error: AlertTriangle, unknown: CircleHelp }
const statuses: Status[] = ['error', 'warning', 'unknown', 'ok']

function parseReport(value: unknown): Report {
  const report = value as Partial<Report> | null
  if (!report || typeof report.checkedAt !== 'string' || !Number.isFinite(Date.parse(report.checkedAt)) || !statuses.includes(report.status as Status) || !Array.isArray(report.checks)) throw new Error('Invalid watchdog report')
  for (const check of report.checks) {
    if (!check || !['id', 'name', 'detail', 'action', 'href'].every(key => typeof check[key as keyof Check] === 'string') || !statuses.includes(check.status) || !/^\/(settings(?:\/watchdog)?|devices(?:\/[0-9a-f-]+\/alerts)?|patch|security)$/.test(check.href)) throw new Error('Invalid watchdog check')
  }
  return report as Report
}

export function WatchdogSection({ token, onDenied, navigate }: SessionProps & { navigate: (path: string) => void }) {
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ token: string; report?: Report; error?: string; loading: boolean }>({ token, loading: true })
  const [filter, setFilter] = useState<Status | 'all'>('all')
  const [search, setSearch] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setState({ token, loading: true })
    const unsubscribe = subscribeAuth(() => { if (getToken() !== token) { active = false; controller.abort(); setState({ token: '', loading: false }) } })
    const timeout = setTimeout(() => {
      if (!active) return
      active = false
      controller.abort()
      setState({ token, loading: false, error: 'Watchdog request timed out. Backend availability is not verified.' })
    }, 8_000)
    void adminRequest<unknown>(token, '/admin/watchdog', controller.signal).then(value => {
      if (active && getToken() === token) setState({ token, loading: false, report: parseReport(value) })
    }).catch(error => {
      if (!active || getToken() !== token) return
      if (accessFailure(error)) { setState({ token: '', loading: false }); onDenied() }
      else setState({ token, loading: false, error: 'Watchdog unavailable. Check backend connectivity and deployment; no healthy status can be confirmed.' })
    }).finally(() => clearTimeout(timeout))
    return () => { active = false; clearTimeout(timeout); controller.abort(); unsubscribe() }
  }, [token, revision, onDenied])
  const current = state.token === token && getToken() === token
  const report = current ? state.report : undefined
  const loading = current && state.loading
  const pageFailures = browserFailures(token)
  const stale = !!report && Date.now() - Date.parse(report.checkedAt) > 120_000
  const checks = report?.checks.filter(check => (filter === 'all' || check.status === filter) && `${check.name} ${check.detail} ${check.action}`.toLowerCase().includes(search.toLowerCase())) ?? []
  checks.sort((left, right) => statuses.indexOf(left.status) - statuses.indexOf(right.status))
  return <section aria-label="ITMS watchdog" className="min-w-0 space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
      <div><h2 className="flex items-center gap-2 text-xl font-bold"><Activity size={22} />ITMS watchdog</h2><p className="mt-1 text-sm text-slate-500">Server interval: 60 seconds. Read-only monitoring.</p></div>
      <button type="button" className="secondary-button inline-flex items-center gap-2" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} />Refresh report</button>
    </div>
    {loading && <p role="status">Loading watchdog report...</p>}
    {current && state.error && <p role="alert" className="break-words border-l-4 border-rose-500 p-3 text-rose-700">{state.error}</p>}
    {pageFailures.length > 0 && <section aria-label="Browser page errors" className="space-y-2 border-l-4 border-rose-500 p-3"><h3 className="font-semibold text-rose-700">Browser page errors</h3><p className="text-xs text-slate-500">Current browser session only. Cleared on account change or reload.</p>{pageFailures.map(failure => <p key={failure.page} className="break-words text-sm">{failure.page}: {failure.count} rendering failures. Last seen: {new Date(failure.lastSeen).toLocaleString()}</p>)}</section>}
    {report && <>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <strong className={stale ? tones.error : tones[report.status]}>{stale ? 'Report stale' : labels[report.status]}</strong>
        <span>Checked: {new Date(report.checkedAt).toLocaleString()}</span>
        <span className="text-slate-500">Deployment readiness: not certified</span>
      </div>
      {stale && <p role="alert" className="text-rose-700">This report is older than two minutes. Refresh before relying on its results.</p>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1 text-sm font-semibold">Search checks<div className="relative mt-1"><Search size={16} className="absolute left-3 top-3 text-slate-400" /><input className="field w-full pl-9" value={search} onChange={event => setSearch(event.target.value)} /></div></label>
        <label className="text-sm font-semibold">Status<select className="field mt-1 block" value={filter} onChange={event => setFilter(event.target.value as Status | 'all')}><option value="all">All checks ({report.checks.length})</option>{statuses.map(status => <option key={status} value={status}>{labels[status]} ({report.checks.filter(check => check.status === status).length})</option>)}</select></label>
      </div>
      <ul className="divide-y border-y" aria-label="Watchdog checks">{checks.map(check => {
        const Icon = icons[check.status]
        return <li key={check.id} className="grid min-w-0 gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0"><h3 className="flex flex-wrap items-center gap-2 font-semibold"><Icon size={17} className={tones[check.status]} /><span>{check.name}</span><span className={`text-xs ${tones[check.status]}`}>{labels[check.status]}</span></h3><p className="mt-2 break-words text-sm">{check.detail}</p>{check.action && <p className="mt-1 break-words text-sm text-slate-500">{check.action}</p>}</div>
          <a href={check.href} className="inline-flex items-center gap-1 self-start text-sm font-semibold text-brand-600" onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); navigate(check.href) } }}>Open <span className="sr-only">{check.name}</span><ArrowUpRight size={15} /></a>
        </li>
      })}</ul>
      {checks.length === 0 && <p className="text-sm text-slate-500">No matching checks.</p>}
    </>}
  </section>
}