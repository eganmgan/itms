import { useEffect, useState } from 'react'
import { Bar, Doughnut } from 'react-chartjs-2'
import { RefreshCw } from 'lucide-react'
import '../lib/charts'
import { useAuthToken } from '../lib/auth'
import { EmployeeAlertList, type EmployeeAlert } from '../components/EmployeeAlertList'

type Asset = { id: string; name: string; category?: string; assetTag?: string | null; itemCode?: string; warrantyExpiresAt?: string | null }
type Props = { assets: Asset[]; assetsLoading: boolean; assetsError: string; requests: { status: string }[]; requestsReady: boolean }

export function EmployeeDashboard({ assets, assetsLoading, assetsError, requests, requestsReady }: Props) {
  const token = useAuthToken()
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ key: string; alerts: EmployeeAlert[]; error: string }>({ key: '', alerts: [], error: '' })
  const key = `${token}:${revision}`
  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    let mounted = true
    const timeout = window.setTimeout(() => controller.abort(), 8000)
    void (async () => {
      try {
        const response = await fetch('/api/me/alerts', { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, cache: 'no-store' })
        if (!response.ok) throw new Error('Alerts unavailable')
        const alerts: EmployeeAlert[] = await response.json()
        if (!Array.isArray(alerts)) throw new Error('Invalid alerts')
        if (mounted && !controller.signal.aborted && token === localStorage.getItem('itms_token')) setState({ key, alerts, error: '' })
      } catch {
        if (mounted && token === localStorage.getItem('itms_token')) setState({ key, alerts: [], error: 'Security alerts unavailable. Refresh to try again.' })
      } finally { window.clearTimeout(timeout) }
    })()
    return () => { mounted = false; controller.abort(); window.clearTimeout(timeout) }
  }, [token, key])
  const loaded = state.key === key
  const alerts = loaded ? state.alerts : []
  const openAlerts = alerts.filter(alert => !alert.resolved)
  const itemCounts = assets.reduce<Record<string, number>>((counts, asset) => { const category = asset.category || 'Other items'; counts[category] = (counts[category] || 0) + 1; return counts }, {})
  const severityLabels = ['Critical', 'High', 'Medium', 'Low', 'Info / other']
  const assetData = { labels: Object.keys(itemCounts), datasets: [{ label: 'Assigned items', data: Object.values(itemCounts), backgroundColor: '#0f766e', borderRadius: 4 }] }
  const alertData = { labels: severityLabels, datasets: [{ data: severityLabels.map((label, index) => openAlerts.filter(alert => index === 4 ? !['critical', 'high', 'medium', 'low'].includes((alert.severity || '').toLowerCase()) : (alert.severity || '').toLowerCase() === label.toLowerCase()).length), backgroundColor: ['#be123c', '#d97706', '#2563eb', '#0f766e', '#64748b'], borderWidth: 0 }] }
  const alertsReady = loaded && !state.error
  return <div className="space-y-6" aria-label="Employee dashboard">
    <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-semibold">My dashboard</h2><button className="secondary-button" disabled={!loaded && !!token} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} />Refresh alerts</button></div>
    <dl className="grid grid-cols-2 gap-5 border-y py-4 sm:grid-cols-4">{[
      ['Assigned items', assetsLoading || assetsError ? '-' : assets.length],
      ['Open alerts', alertsReady ? openAlerts.length : '-'],
      ['Open requests', requestsReady ? requests.filter(request => !['resolved', 'rejected'].includes(request.status)).length : '-'],
      ['Resolved requests', requestsReady ? requests.filter(request => request.status === 'resolved').length : '-'],
    ].map(([label, value]) => <div key={label}><dt className="text-xs text-slate-500">{label}</dt><dd className="mt-1 text-2xl font-semibold">{value}</dd></div>)}</dl>
    <div className="grid gap-8 md:grid-cols-2">
      <section aria-label="Items by type"><h3 className="mb-3 font-semibold">Items by type</h3>{assetsLoading ? <p role="status">Loading assigned items...</p> : assetsError ? <p role="alert">{assetsError}</p> : assets.length ? <div className="h-56 min-w-0"><Bar aria-label="Assigned items by type" role="img" data={assetData} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }} /></div> : <p>No items assigned.</p>}</section>
      <section aria-label="Open alert severity"><h3 className="mb-3 font-semibold">Open alert severity</h3>{!token ? <p>Sign in to load alerts.</p> : !loaded ? <p role="status">Loading security alerts...</p> : state.error ? <p role="alert">{state.error}</p> : openAlerts.length ? <div className="h-56 min-w-0"><Doughnut aria-label="Open alerts by severity" role="img" data={alertData} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }} /></div> : <p>No open security alerts.</p>}</section>
    </div>
    <section aria-label="Current items" className="space-y-3"><h3 className="font-semibold">Current items</h3>{!assetsLoading && !assetsError && <div className="table-shell overflow-x-auto"><table className="data-table"><thead><tr><th>Item</th><th>Asset tag</th><th>Warranty expiry</th></tr></thead><tbody>{assets.map(asset => <tr key={asset.id}><td>{asset.name}</td><td>{asset.assetTag || asset.itemCode || '-'}</td><td>{asset.warrantyExpiresAt || 'Not recorded'}</td></tr>)}{!assets.length && <tr><td colSpan={3}>No items assigned.</td></tr>}</tbody></table></div>}</section>
    <section aria-label="Dashboard security alerts"><h3 className="font-semibold">Security alerts</h3>{alertsReady && <EmployeeAlertList alerts={alerts} />}</section>
  </div>
}