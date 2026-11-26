import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, ArrowUpRight, KeyRound, Laptop, LayoutDashboard, List, PieChart, RefreshCw, ShieldCheck } from 'lucide-react'
import { Chart, Doughnut } from 'react-chartjs-2'
import type { ChartData } from 'chart.js'
import '../lib/charts'
import { readJson } from '../lib/api'
import { normalizeTrendBuckets } from '../lib/dashboard'

const chartOptions = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' as const, labels: { usePointStyle: true, boxWidth: 8, padding: 16, font: { size: 10 } } } } }

interface DashboardData {
  devices: { summary: { all: number; flagged: number }; users: Array<{ status: string }> }
  patches: { total: number; upToDate: number; pending: number; failed: number; rebootPending: number }
  security: { systems: Array<{ status: string }>; trend: { dailyBuckets: Array<{ date: string; count: number }> } }
  gatepasses: Array<{ status: string }>
  audit: Array<{ id: string; createdAt: string; module: string; summary: string; action: string; actor?: { fullName?: string; email?: string } }>
  profile: { full_name: string }
}
type DashboardSections = { [K in keyof DashboardData]: DashboardData[K] | null }

export function DashboardView() {
  const [data, setData] = useState<DashboardSections | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const loadGeneration = useRef(0)
  const loadController = useRef<AbortController | null>(null)
  const loadDashboard = useCallback(async () => {
    const generation = ++loadGeneration.current
    loadController.current?.abort()
    const token = localStorage.getItem('itms_token')
    if (!token) { setData(null); setLoading(false); setError('Sign in to load dashboard data.'); return }
    const controller = new AbortController()
    loadController.current = controller
    const timeout = window.setTimeout(() => controller.abort(), 8000)
    const current = () => generation === loadGeneration.current && token === localStorage.getItem('itms_token')
    setLoading(true)
    try {
      const headers = { Authorization: `Bearer ${token}` }
      async function loadSection<T>(path: string): Promise<T> {
        const response = await fetch(`/api${path}`, { headers, signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return readJson<T>(response)
      }
      const results = await Promise.allSettled([
        loadSection<DashboardData['devices']>('/devices/directory'),
        loadSection<DashboardData['patches']>('/patch/dashboard'),
        loadSection<DashboardData['security']>('/alerts/dashboard'),
        loadSection<DashboardData['gatepasses']>('/gatepass'),
        loadSection<DashboardData['audit']>('/audit'),
        loadSection<DashboardData['profile']>('/me/profile'),
      ] as const)
      if (!current()) return
      const value = <T,>(result: PromiseSettledResult<T>) => result.status === 'fulfilled' ? result.value : null
      setData({ devices: value(results[0]), patches: value(results[1]), security: value(results[2]), gatepasses: value(results[3]), audit: value(results[4]), profile: value(results[5]) })
      const names = ['devices', 'patches', 'security', 'gatepasses', 'activity', 'profile']
      const failures = results.flatMap((result, index) => result.status === 'rejected' ? [names[index]] : [])
      setError(failures.length ? `Unable to load: ${failures.join(', ')}. ${controller.signal.aborted ? 'The request timed out. ' : ''}Try again.` : '')
    } catch (loadError) { if (current()) { setData(null); setError(controller.signal.aborted ? 'Dashboard request timed out. Refresh to try again.' : loadError instanceof Error ? loadError.message : 'Dashboard API unavailable') } }
    finally { window.clearTimeout(timeout); controller.abort(); if (current()) setLoading(false) }
  }, [])
  const cancelLoading = useCallback(() => { ++loadGeneration.current; loadController.current?.abort() }, [])
  useEffect(() => {
    const accountChanged = () => { setData(null); void loadDashboard() }
    const storageChanged = (event: StorageEvent) => { if (event.key === 'itms_token' || event.key === null) accountChanged() }
    void loadDashboard()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void loadDashboard() }, 60_000)
    window.addEventListener('itms-auth-changed', accountChanged)
    window.addEventListener('storage', storageChanged)
    return () => { window.clearInterval(timer); cancelLoading(); window.removeEventListener('itms-auth-changed', accountChanged); window.removeEventListener('storage', storageChanged) }
  }, [loadDashboard, cancelLoading])

  const online = data?.devices?.users.filter((item) => item.status === 'online').length ?? 0
  const offline = data?.devices?.users.filter((item) => item.status === 'offline').length ?? 0
  const pendingGatepasses = data?.gatepasses?.filter((item) => item.status === 'pending').length ?? 0
  const securityErrors = data?.security?.systems.filter((item) => item.status === 'error').length ?? 0
  const compliance = data?.patches?.total ? Math.round((data.patches.upToDate / data.patches.total) * 1000) / 10 : null
  const deviceData = { labels: [`Online (${online})`, `Offline (${offline})`, `Needs Patch (${(data?.patches?.pending ?? 0) + (data?.patches?.failed ?? 0)})`, `Flagged (${data?.devices?.summary.flagged ?? 0})`], datasets: [{ data: [online, offline, (data?.patches?.pending ?? 0) + (data?.patches?.failed ?? 0), data?.devices?.summary.flagged ?? 0], backgroundColor: ['#10b981', '#94a3b8', '#3b82f6', '#f43f5e'], borderWidth: 0, spacing: 2 }] }
  const trend = normalizeTrendBuckets(data?.security?.trend?.dailyBuckets)
  const operationsData: ChartData<'bar'> = { labels: trend.map((item) => item.date.length > 5 ? item.date.slice(5) : item.date), datasets: [{ type: 'bar', label: 'SIEM Security Alerts', data: trend.map((item) => item.count), backgroundColor: 'rgba(244,63,94,.7)', borderRadius: 6 }] }
  const metrics = [
    { label: 'Total Active Devices', value: data?.devices ? `${data.devices.summary.all} Endpoints` : '-', note: data?.devices ? `${online} currently online` : 'Data unavailable', icon: Laptop, tone: 'text-brand-600 bg-blue-50 dark:bg-blue-900/30', noteTone: 'text-emerald-600', arrow: true },
    { label: 'Pending Gatepasses', value: data?.gatepasses ? `${pendingGatepasses} Requests` : '-', note: data?.gatepasses ? 'Requires authorization' : 'Data unavailable', icon: KeyRound, tone: 'text-amber-600 bg-amber-50 dark:bg-amber-900/30', noteTone: 'text-amber-600' },
    { label: 'Systems With Findings', value: data?.security ? String(securityErrors) : '-', note: data?.security ? 'Recorded security findings' : 'Data unavailable', icon: ShieldCheck, tone: 'text-amber-600 bg-amber-50 dark:bg-amber-900/30', noteTone: 'text-amber-600' },
    { label: 'Patch Compliance Rate', value: compliance === null ? '-' : `${compliance}%`, note: data?.patches ? data.patches.total ? `${data.patches.upToDate} systems current` : 'No evaluated systems' : 'Data unavailable', icon: RefreshCw, tone: 'text-indigo-600 bg-indigo-50 dark:bg-indigo-900/30', noteTone: 'text-indigo-600' },
  ]

  return <section className="page-enter mx-auto max-w-[1600px] space-y-6">
    <div className="card flex flex-col justify-between gap-3 p-6 sm:flex-row sm:items-start"><div><h1 className="flex items-center gap-2.5 text-2xl font-black tracking-tight"><LayoutDashboard className="text-brand-600" size={24} />Welcome, <span className="text-brand-600 dark:text-blue-400">{data?.profile?.full_name || 'ITMS user'}</span></h1><p className="mt-1 text-xs text-slate-500">Cross-module operational status: Asset telemetry, gatepass movements, Salt patch jobs, and SIEM security metrics.</p></div></div>
    {error && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700">{error} <button type="button" className="underline" disabled={loading} onClick={() => void loadDashboard()}>Retry</button></div>}
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{metrics.map(({ label, value, note, icon: Icon, tone, noteTone, arrow }) => <article className="card space-y-2 p-5" key={label}><div className="flex items-center justify-between"><span className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</span><span className={`rounded-xl p-2 ${tone}`}><Icon size={16} /></span></div><p className={`text-3xl font-black ${label === 'Pending Gatepasses' ? 'text-amber-600' : label === 'Security Health Index' ? 'text-emerald-600' : label === 'Patch Compliance Rate' ? 'text-indigo-600' : ''}`}>{value}</p><p className={`flex items-center gap-1 text-[11px] font-bold ${noteTone}`}>{arrow && <ArrowUpRight size={14} />}{note}</p></article>)}</div>
    <div className="grid gap-6 lg:grid-cols-3"><article className="card space-y-3 p-5"><div className="flex items-center justify-between"><h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider"><PieChart size={16} className="text-brand-600" />Device Status Breakdown</h2><span className="font-mono text-[10px] text-slate-400">{data?.devices && data?.patches ? 'Recorded inventory' : 'Data unavailable'}</span></div><div className="h-64">{data?.devices && data?.patches ? <Doughnut data={deviceData} options={{ ...chartOptions, cutout: '62%' }} /> : <p className="text-sm text-slate-500">{loading ? 'Loading device status...' : 'Device status unavailable.'}</p>}</div></article><article className="card space-y-3 p-5 lg:col-span-2"><div className="flex items-center justify-between"><h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider"><Activity size={16} className="text-indigo-600" />Weekly Security Events</h2><span className="font-mono text-[10px] text-slate-400">{data?.security ? 'Recorded 7-day stream' : 'Data unavailable'}</span></div><div className="h-64">{data?.security ? <Chart type="bar" data={operationsData} options={{ ...chartOptions, plugins: { ...chartOptions.plugins, legend: { ...chartOptions.plugins.legend, position: 'top' } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: 'rgba(148,163,184,.15)' } } } }} /> : <p className="text-sm text-slate-500">{loading ? 'Loading security trend...' : 'Security trend unavailable.'}</p>}</div></article></div>
    <div className="table-shell"><div className="flex items-center justify-between border-b p-4"><h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider"><List size={16} className="text-brand-600" />Recent System Activity Log</h2><span className="rounded-full bg-blue-100 px-2.5 py-0.5 font-mono text-[10px] font-bold text-blue-700">{data?.audit ? 'API synchronized' : 'Not verified'}</span></div><div className="overflow-x-auto"><table className="data-table font-mono"><thead><tr>{['Timestamp', 'Module', 'User / Email', 'Activity Description', 'Status'].map((heading) => <th key={heading} className={heading === 'Status' ? 'text-right' : ''}>{heading}</th>)}</tr></thead><tbody>{data?.audit?.length ? data.audit.slice(0, 8).map((row) => <tr key={row.id}><td className="text-slate-400">{new Date(row.createdAt).toLocaleString()}</td><td className="font-bold text-brand-600">{row.module}</td><td className="font-sans text-slate-700 dark:text-slate-300">{row.actor?.fullName || row.actor?.email || 'System'}</td><td>{row.summary}</td><td className="text-right"><span className="rounded bg-slate-100 px-2 py-0.5 font-bold text-slate-600">{row.action}</span></td></tr>) : <tr><td colSpan={5} className="py-10 text-center text-slate-500">{loading ? 'Loading system activity...' : data?.audit ? 'No system activity.' : 'System activity unavailable.'}</td></tr>}</tbody></table></div></div>
  </section>
}
