import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Download, FileText, Play, Plus, RefreshCw, ScanSearch, ShieldAlert, Trash2 } from 'lucide-react'
import { Doughnut, Line } from 'react-chartjs-2'
import '../lib/charts'
import { Badge, Modal, ModuleWorkspace, PageHeader, Terminal } from '../components/ui'
import { exportCsv, exportElementPdf } from '../lib/exports'
import type { Tone } from '../types'
import { usePortalReadOnly } from '../lib/portalAccess'
import { EmployeeAlertList, type EmployeeAlert } from '../components/EmployeeAlertList'
import { subscribeAuth } from '../lib/auth'

const modules = ['Wazuh SIEM', 'OpenSCAP', 'ClamAV', 'CVE Detector']
const sourceByModule: Record<string, string> = { 'Wazuh SIEM': 'wazuh', OpenSCAP: 'openscap', ClamAV: 'clamav', 'CVE Detector': 'cve' }
const scriptBySource: Record<string, string[]> = {
  wazuh: ['#!/usr/bin/env bash', 'set -euo pipefail', 'sudo systemctl restart wazuh-agent', 'sudo systemctl is-active wazuh-agent'],
  openscap: ['#!/usr/bin/env bash', 'set -euo pipefail', 'sudo oscap xccdf eval --profile cis /usr/share/xml/scap/ssg/content/ssg-ubuntu2204-ds.xml'],
  clamav: ['#!/usr/bin/env bash', 'set -euo pipefail', 'sudo freshclam', 'sudo clamscan --recursive --infected /home'],
  cve: ['#!/usr/bin/env bash', 'set -euo pipefail', 'sudo apt-get update -qq', 'sudo apt-get upgrade --with-new-pkgs -y'],
}

interface SecuritySystem { key: string; assetId?: string; hostname: string; userEmail?: string; moduleLabel: string; severity?: string; latestTitle: string; latestDetail: string; createdAt: string; status: string; errorCount: number }
interface TrendBucket { date: string; count: number }
interface SecurityDashboard { source: string; sourceLabel: string; systems: SecuritySystem[]; trend: { dailyBuckets: TrendBucket[]; last7DaysTotal: number }; moduleCards: IntegrationCard[] }
interface IntegrationCard { source: string; label: string; configured?: boolean; eventCount?: number }
interface SecurityAutomation { id: string; name: string; source: string; kind: 'sls' | 'sh'; content: string; description: string }
interface SecurityReport { id: string; source: string; label: string; total: number; open: number; critical: number; resolved: number; generatedAt: string }

async function securityRequest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(payload.error || `Security API request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

function severityTone(severity = ''): Tone {
  if (severity.toLowerCase() === 'critical') return 'rose'
  if (severity.toLowerCase() === 'high') return 'amber'
  return 'blue'
}

export function SecurityPage({ role }: { role?: string }) {
  const portalReadOnly = usePortalReadOnly()
  const readOnly = portalReadOnly || role === 'employee'
  const [module, setModule] = useState('Wazuh SIEM')
  const [workspaceSection, setWorkspaceSection] = useState('Security')
  const [dashboard, setDashboard] = useState<SecurityDashboard | null>(null)
  const [integrations, setIntegrations] = useState<IntegrationCard[]>([])
  const [automations, setAutomations] = useState<SecurityAutomation[]>([])
  const [reports, setReports] = useState<SecurityReport[]>([])
  const [employeeAlerts, setEmployeeAlerts] = useState<EmployeeAlert[]>([])
  const [dashboardLoading, setDashboardLoading] = useState(false)
  const [dashboardError, setDashboardError] = useState('')
  const [selectedEvent, setSelectedEvent] = useState<SecuritySystem | null>(null)
  const [automationOpen, setAutomationOpen] = useState(false)
  const [automationName, setAutomationName] = useState('')
  const [automationContent, setAutomationContent] = useState('')
  const [automationKind, setAutomationKind] = useState<'sls' | 'sh'>('sh')
  const [live, setLive] = useState(false)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [apiError, setApiError] = useState('')
  const reportRef = useRef<HTMLDivElement>(null)
  const loadGeneration = useRef(0)
  const loadController = useRef<AbortController | null>(null)
  const dashboardGeneration = useRef(0)
  const dashboardController = useRef<AbortController | null>(null)
  const source = sourceByModule[module]
  const sourceRef = useRef(source)
  sourceRef.current = source

  const loadSecurityWorkspace = useCallback(async () => {
    const generation = ++loadGeneration.current
    loadController.current?.abort()
    const token = localStorage.getItem('itms_token')
    setLive(false); setDashboard(null); setIntegrations([]); setAutomations([]); setReports([]); setEmployeeAlerts([]); setSelectedEvent(null); setAutomationOpen(false); setApiError('')
    if (!token) { setLoading(false); setApiError('Sign in to load security data.'); return }
    const controller = new AbortController()
    loadController.current = controller
    const timeout = window.setTimeout(() => controller.abort(), 8000)
    const current = () => generation === loadGeneration.current && token === localStorage.getItem('itms_token')
    setLoading(true)
    try {
      if (role === 'employee') {
        const alerts = await securityRequest<EmployeeAlert[]>('/me/alerts', token, { signal: controller.signal })
        if (!current() || controller.signal.aborted) return
        if (!Array.isArray(alerts)) throw new Error('Security alerts unavailable')
        setEmployeeAlerts(alerts); setLive(true)
        return
      }
      const [integrationData, automationData, reportData] = await Promise.all([
        securityRequest<{ items: IntegrationCard[] }>('/security/integrations', token, { signal: controller.signal }),
        securityRequest<{ items: SecurityAutomation[] }>('/security/automations', token, { signal: controller.signal }),
        securityRequest<{ items: SecurityReport[] }>('/security/reports', token, { signal: controller.signal }),
      ])
      if (!current() || controller.signal.aborted) return
      setIntegrations(integrationData.items); setAutomations(automationData.items); setReports(reportData.items); setLive(true); setApiError('')
    } catch (error) {
      if (current()) { setApiError(controller.signal.aborted ? 'Security request timed out. Refresh to try again.' : error instanceof Error ? error.message : 'Security workspace unavailable'); setLive(false) }
    } finally { window.clearTimeout(timeout); controller.abort(); if (current()) setLoading(false) }
  }, [role])

  const loadSecurityDashboard = useCallback(async (selectedSource: string) => {
    const generation = ++dashboardGeneration.current
    dashboardController.current?.abort()
    const token = localStorage.getItem('itms_token')
    if (!token) { setDashboardLoading(false); return }
    const controller = new AbortController()
    dashboardController.current = controller
    const timeout = window.setTimeout(() => controller.abort(), 8000)
    const current = () => generation === dashboardGeneration.current && token === localStorage.getItem('itms_token') && selectedSource === sourceRef.current
    setDashboard(null)
    setDashboardError('')
    setDashboardLoading(true)
    try {
      const dashboardData = await securityRequest<SecurityDashboard>(`/security/dashboard?source=${selectedSource}`, token, { signal: controller.signal })
      if (!current() || controller.signal.aborted) return
      setDashboard(dashboardData)
    } catch (error) {
      if (current()) setDashboardError(controller.signal.aborted ? 'Security dashboard request timed out. Refresh to try again.' : error instanceof Error ? error.message : 'Security dashboard unavailable')
    } finally {
      window.clearTimeout(timeout)
      controller.abort()
      if (current()) setDashboardLoading(false)
    }
  }, [])

  const cancelLoading = useCallback(() => { ++loadGeneration.current; loadController.current?.abort() }, [])
  useEffect(() => { void loadSecurityWorkspace(); return cancelLoading }, [loadSecurityWorkspace, cancelLoading])
  const cancelDashboardLoading = useCallback(() => { ++dashboardGeneration.current; dashboardController.current?.abort() }, [])
  useEffect(() => {
    if (role === 'employee') return
    void loadSecurityDashboard(source)
    return cancelDashboardLoading
  }, [source, role, loadSecurityDashboard, cancelDashboardLoading])
  const refreshSecurityWorkspace = useCallback(() => Promise.all([
    loadSecurityWorkspace(),
    role !== 'employee' ? loadSecurityDashboard(sourceRef.current) : Promise.resolve(),
  ]), [loadSecurityWorkspace, loadSecurityDashboard, role])
  useEffect(() => subscribeAuth(refreshSecurityWorkspace), [refreshSecurityWorkspace])
  useEffect(() => { if (!notice) return; const timeout = window.setTimeout(() => setNotice(''), 3200); return () => window.clearTimeout(timeout) }, [notice])

  const visibleEvents = live ? dashboard?.systems ?? [] : []
  const buckets = live ? dashboard?.trend.dailyBuckets ?? [] : []
  const severityCounts = visibleEvents.reduce((counts, item) => { const key = item.severity?.toLowerCase() || 'info'; counts[key] = (counts[key] || 0) + 1; return counts }, {} as Record<string, number>)
  const lineData = { labels: buckets.map((item) => item.date.slice(5) || item.date), datasets: [{ label: `${module} findings`, data: buckets.map((item) => item.count), borderColor: '#e11d48', backgroundColor: 'rgba(225,29,72,.12)', fill: true, tension: 0.35 }] }
  const doughnutData = { labels: ['Critical', 'High', 'Medium', 'Other'], datasets: [{ data: [severityCounts.critical || 0, severityCounts.high || 0, severityCounts.medium || 0, severityCounts.low || severityCounts.info || 0], backgroundColor: ['#e11d48', '#f59e0b', '#2563eb', '#16a34a'], borderWidth: 0, spacing: 2 }] }
  const chartOptions = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' as const, labels: { usePointStyle: true, boxWidth: 8, padding: 16 } } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: 'rgba(148,163,184,.15)' } } } }

  function openAutomation(event?: SecuritySystem) {
    if (readOnly) return
    if (!live || loading) return
    const selectedSource = event ? source : sourceByModule[module]
    setSelectedEvent(null); setAutomationName(event ? `${selectedSource}-${event.hostname}-remediation` : `${selectedSource}-remediation`); setAutomationContent(scriptBySource[selectedSource].join('\n')); setAutomationKind('sh'); setAutomationOpen(true)
  }

  async function saveAutomation() {
    if (readOnly) return
    if (!live || loading) return
    const token = localStorage.getItem('itms_token')
    if (!token) { setApiError('Connect your ITMS account to save security automations.'); return }
    try {
      await securityRequest('/security/automations', token, { method: 'POST', body: JSON.stringify({ name: automationName, source, kind: automationKind, content: automationContent, description: `Reviewed ${module} remediation` }) })
      setAutomationOpen(false); setNotice('Security automation saved.'); await refreshSecurityWorkspace()
    } catch (error) { setApiError(error instanceof Error ? error.message : 'Automation could not be saved') }
  }

  async function deleteAutomation(id: string) {
    if (readOnly) return
    if (!live || loading) return
    const token = localStorage.getItem('itms_token')
    if (!token) return
    try { await securityRequest(`/security/automations/${id}`, token, { method: 'DELETE' }); setNotice('Security automation deleted.'); await refreshSecurityWorkspace() }
    catch (error) { setApiError(error instanceof Error ? error.message : 'Automation could not be deleted') }
  }

  if (role === 'employee') return <div className="page-enter mx-auto max-w-[1200px] space-y-5">
    <div className="flex items-center justify-between gap-3"><h1 className="text-2xl font-bold">Security alerts</h1><button className="secondary-button" disabled={loading} onClick={() => void loadSecurityWorkspace()}><RefreshCw size={16} />Refresh</button></div>
    {apiError && <p role="alert" className="text-sm text-rose-700">{apiError}</p>}
    {loading ? <p role="status">Loading alerts...</p> : live && <EmployeeAlertList alerts={employeeAlerts} />}
  </div>

  return <div className="page-enter mx-auto max-w-[1500px] space-y-6">
    <PageHeader eyebrow="Security operations" title="SOC operations & SIEM" description="Correlated threat analytics, compliance posture, automation, and reports." />
    {(apiError || dashboardError) && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700">{apiError || dashboardError}</div>}
    <ModuleWorkspace label="Security Center" sections={role === 'employee' ? ['Security', 'Reports'] : ['Security', 'Automations', 'Reports']} activeSection={workspaceSection} onSectionChange={setWorkspaceSection}>
      {workspaceSection === 'Security' && <>
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{integrations.map((item) => <button key={item.source} onClick={() => setModule(modules.find((name) => sourceByModule[name] === item.source) || module)} className={`card p-4 text-left ${source === item.source ? 'ring-2 ring-brand-600' : ''}`}><div className="flex items-center justify-between"><ShieldAlert size={18} className={item.configured ? 'text-emerald-600' : 'text-slate-400'} /><Badge tone={item.configured ? 'green' : 'amber'}>{item.configured === true ? 'Configured' : item.configured === false ? 'Not configured' : 'Not verified'}</Badge></div><p className="mt-3 text-sm font-extrabold">{item.label}</p><p className="mt-1 text-xs text-slate-500">{item.eventCount ?? 0} ingested events</p></button>)}</section>
        <section className="grid gap-5 xl:grid-cols-[1.5fr_0.7fr]"><article className="card p-5"><div className="flex items-center justify-between"><div><h2 className="font-extrabold">Seven-day threat stream</h2><p className="text-xs text-slate-500">Live findings for {module}</p></div><ScanSearch className="text-rose-600" size={20} /></div><div className="mt-4 h-72"><Line data={lineData} options={chartOptions} /></div></article><article className="card p-5"><h2 className="font-extrabold">Severity breakdown</h2><p className="text-xs text-slate-500">Latest status by system</p><div className="mt-4 h-72"><Doughnut data={doughnutData} options={{ ...chartOptions, cutout: '64%', scales: undefined }} /></div></article></section>
        <section><div className="mb-3 flex items-end justify-between"><div><h2 className="font-extrabold">Security event log</h2><p className="text-xs text-slate-500">Showing {module} detections</p></div><Badge tone="rose">{live ? `${visibleEvents.length} systems` : 'Not verified'}</Badge></div><div className="table-shell overflow-x-auto"><table className="data-table"><thead><tr>{['Timestamp', 'Module', 'System ID', 'Email ID', 'Security Log / Rule Description', 'Severity', 'Action'].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{visibleEvents.length === 0 ? <tr><td colSpan={7} className="py-10 text-center text-slate-500">{dashboardLoading ? 'Loading security findings...' : live ? `No ${module} findings are currently ingested.` : 'Security findings unavailable.'}</td></tr> : visibleEvents.map((item) => <tr key={item.key}><td className="font-mono text-xs">{new Date(item.createdAt).toLocaleString()}</td><td className="font-bold">{item.moduleLabel}</td><td className="font-mono text-xs text-brand-600">{item.hostname}</td><td className="text-slate-500">{item.userEmail || 'Unassigned'}</td><td className="max-w-md"><p className="font-bold">{item.latestTitle}</p><p className="text-xs text-slate-500">{item.latestDetail}</p></td><td><Badge tone={severityTone(item.severity)}>{item.severity || 'Info'}</Badge></td><td><button className="primary-button !h-8 !px-3" onClick={() => setSelectedEvent(item)}><Play size={13} />Review fix</button></td></tr>)}</tbody></table></div></section>
      </>}
      {workspaceSection === 'Automations' && <fieldset disabled={readOnly} className="space-y-4"><div className="flex items-end justify-between"><div><h2 className="font-extrabold">Security automations</h2><p className="text-xs text-slate-500">Reviewed Salt and shell remediation definitions</p></div><button className="primary-button" disabled={!live || loading} onClick={() => openAutomation()}><Plus size={15} />New automation</button></div><div className="table-shell overflow-x-auto"><table className="data-table"><thead><tr>{['Name', 'Detector', 'Kind', 'Description', 'Action'].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{automations.length === 0 ? <tr><td colSpan={5} className="py-10 text-center text-slate-500">{loading ? 'Loading security automations...' : live ? 'No persisted security automations.' : 'Security automations unavailable.'}</td></tr> : automations.map((item) => <tr key={item.id}><td className="font-bold">{item.name}</td><td>{item.source}</td><td><Badge>{item.kind}</Badge></td><td>{item.description}</td><td><button className="icon-button text-rose-600" aria-label={`Delete ${item.name}`} onClick={() => void deleteAutomation(item.id)}><Trash2 size={15} /></button></td></tr>)}</tbody></table></div></fieldset>}
      {workspaceSection === 'Reports' && <section className="space-y-4" ref={reportRef}><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-extrabold">Security reports</h2><p className="text-xs text-slate-500">Generated from current entity-scoped detector events</p></div><div className="flex gap-2"><button className="secondary-button" disabled={!live || loading || !reports.length} onClick={() => exportCsv('itms-security-report.csv', [['Detector', 'Total', 'Open', 'Critical', 'Resolved'], ...reports.map((item) => [item.label, item.total, item.open, item.critical, item.resolved])])}><Download size={15} />CSV</button><button className="secondary-button" disabled={!live || loading || !reports.length} onClick={() => reportRef.current && void exportElementPdf(reportRef.current, 'itms-security-report.pdf')}><FileText size={15} />PDF</button></div></div><div className="table-shell overflow-x-auto"><table className="data-table"><thead><tr>{['Detector', 'Total', 'Open', 'Critical', 'Resolved', 'Generated'].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{reports.length === 0 ? <tr><td colSpan={6} className="py-10 text-center text-slate-500">{loading ? 'Loading security reports...' : live ? 'No security reports returned.' : 'Security reports unavailable.'}</td></tr> : reports.map((item) => <tr key={item.id}><td className="font-bold">{item.label}</td><td>{item.total}</td><td>{item.open}</td><td className="font-bold text-rose-600">{item.critical}</td><td>{item.resolved}</td><td>{new Date(item.generatedAt).toLocaleString()}</td></tr>)}</tbody></table></div></section>}
    </ModuleWorkspace>
    {selectedEvent && <Modal title="Review remediation" onClose={() => setSelectedEvent(null)} size="max-w-3xl"><div className="space-y-4 p-5"><div className="rounded-md border bg-slate-50 p-3 text-xs dark:bg-slate-950"><p className="font-bold">{selectedEvent.hostname} · {selectedEvent.latestTitle}</p><p className="mt-1 text-slate-500">Review only. Execution requires selecting an approved target in the Salt workspace.</p></div><Terminal lines={scriptBySource[source]} /><div className="flex justify-end gap-2"><button className="secondary-button" onClick={() => setSelectedEvent(null)}>Cancel</button><button className="primary-button" disabled={readOnly} onClick={() => openAutomation(selectedEvent)}><CheckCircle2 size={15} />Save as automation</button></div></div></Modal>}
    {automationOpen && <Modal title="Security automation" onClose={() => setAutomationOpen(false)} size="max-w-3xl"><div className="space-y-4 p-5"><div className="grid gap-3 sm:grid-cols-[1fr_140px]"><label className="text-xs font-bold">Name<input className="mt-1 w-full rounded-md border bg-transparent px-3 py-2" value={automationName} onChange={(event) => setAutomationName(event.target.value)} /></label><label className="text-xs font-bold">Kind<select className="mt-1 w-full rounded-md border bg-transparent px-3 py-2" value={automationKind} onChange={(event) => setAutomationKind(event.target.value as 'sls' | 'sh')}><option value="sh">Shell</option><option value="sls">Salt SLS</option></select></label></div><label className="block text-xs font-bold">Definition<textarea className="mt-1 min-h-56 w-full rounded-md border bg-slate-950 p-3 font-mono text-xs text-slate-100" value={automationContent} onChange={(event) => setAutomationContent(event.target.value)} /></label><div className="flex justify-end gap-2"><button className="secondary-button" onClick={() => setAutomationOpen(false)}>Cancel</button><button className="primary-button" disabled={!automationName.trim() || !automationContent.trim()} onClick={() => void saveAutomation()}>Save automation</button></div></div></Modal>}
    {notice && <div role="status" className="fixed bottom-6 right-6 z-50 flex items-center gap-3 rounded-md bg-emerald-600 px-4 py-3 text-sm font-bold text-white shadow-xl"><CheckCircle2 size={18} />{notice}</div>}
  </div>
}
