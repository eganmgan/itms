import { lazy, Suspense, useState } from 'react'
import { AppWindow, Copy, RefreshCw } from 'lucide-react'
import { Badge, PageHeader, Tabs } from '../components/ui'
import { useAuthToken } from '../lib/auth'
import { inventoryFreshness, inventoryReportFreshness } from '../lib/inventoryFreshness'
import type { DirectoryUser } from './DevicesPage'
import { DeviceLifecycleEditor } from './DeviceLifecycleEditor'
import { networkInterfaces, networkSection, recorded, systemSections } from './device-overview/model'
import type { RecordedValue } from './device-overview/model'
import { useDeviceOverview } from './device-overview/useDeviceOverview'

const tabs = ['Overview', 'System', 'Apps', 'Services', 'Updates', 'Alerts', 'History']
const AppsServicesPanel = lazy(() => import('./AppsServicesPanel').then(module => ({ default: module.AppsServicesPanel })))

function CopyID({ label, value }: { label: string; value: string }) {
  const [result, setResult] = useState('')
  return <span className="ml-2 inline-flex items-center gap-2">
    <button type="button" className="secondary-button" aria-label={`Copy ${label}`} onClick={async () => {
      try { await navigator.clipboard.writeText(value); setResult('Copied') }
      catch { setResult('Copy unavailable. Select the ID to copy it.') }
    }}><Copy size={14} /></button>
    <span role="status" className="text-xs text-slate-500">{result}</span>
  </span>
}

function InfoSection({ title, fields, copyIDs = false }: { title: string; fields: Array<[string, RecordedValue]>; copyIDs?: boolean }) {
  return <section aria-label={title} className="card p-5">
    <h2 className="border-b pb-2 text-xs font-black uppercase tracking-widest text-brand-600">{title}</h2>
    <dl className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{fields.map(([label, value]) => <div key={label}>
      <dt className="text-[11px] font-bold text-slate-400">{label}</dt><dd className="mt-1 break-words text-sm font-semibold">{recorded(value)}
        {copyIDs && recorded(value) !== 'Not recorded' && <CopyID key={`${label}:${recorded(value)}`} label={label} value={recorded(value)} />}
      </dd>
    </div>)}</dl>
  </section>
}

export function DeviceOverviewPage({ device = null, assetId, pathname, onNavigate }: { device?: DirectoryUser | null; assetId?: string; pathname?: string; onNavigate?: (path: string) => void }) {
  const token = useAuthToken()
  if (!token) return <section className="card p-6"><h1 className="text-xl font-bold">Sign-in required</h1>
    <p className="my-3">Sign in to view device details.</p>
    <button className="primary-button" onClick={() => window.dispatchEvent(new Event('itms-open-sign-in'))}>Sign in</button>
  </section>
  const selectedAssetId = assetId || device?.primaryAssetId
  if (!selectedAssetId) return <section className="card p-6"><h1 className="text-xl font-bold">No device selected</h1><p className="mt-3">Select an endpoint from Devices to view its recorded inventory.</p></section>
  // Never reuse details or tab data across accounts/devices.
  // Identity comes from the scoped detail response, not a possibly stale directory row.
  return <DeviceSession key={JSON.stringify([token, selectedAssetId])} token={token} assetId={selectedAssetId} pathname={pathname} onNavigate={onNavigate} />
}

function DeviceSession({ token, assetId, pathname, onNavigate }: { token: string; assetId: string; pathname?: string; onNavigate?: (path: string) => void }) {
  const [localTab, setLocalTab] = useState('Overview')
  const requestedTab = pathname?.split('/')[3]
  const tab = pathname ? requestedTab === 'applications' ? 'Apps' : tabs.find(item => item.toLowerCase() === requestedTab) || 'Overview' : localTab
  const setTab = (next: string) => { if (onNavigate) onNavigate(`/devices/${encodeURIComponent(assetId)}${next === 'Overview' ? '' : `/${next.toLowerCase()}`}`); else setLocalTab(next) }
  const state = useDeviceOverview(token, assetId, tab)
  const { detail, connectivity, history, alerts } = state
  const data = detail.data
  const interfaces = data ? networkInterfaces(data) : []
  const connected = connectivity.data?.connected ?? null
  const status = connected === true ? 'Online' : connected === false ? 'Offline' : 'Unknown'
  const title = data?.name?.trim() || data?.hostname?.trim() || 'Device details'
  const source = connectivity.data?.connectivitySource
  const sourceLabel = source === 'agent_heartbeat' ? 'Agent heartbeat' : source === 'salt_ping' ? 'Salt ping' : source === 'salt_unavailable' ? 'Salt unavailable' :
    source === 'salt_unconfigured' ? 'Salt not configured' : source === 'unmanaged' ? 'Unmanaged endpoint' : 'Not checked'
  if (state.denied) return <section className="card p-6"><h1 className="text-xl font-bold">Device unavailable</h1>
    <p role="alert" className="my-3">{state.denied}</p>
    {state.denied.includes('Sign in') && <button className="primary-button" onClick={() => window.dispatchEvent(new Event('itms-open-sign-in'))}>Sign in</button>}
  </section>

  return <div className="page-enter mx-auto max-w-[1500px] space-y-5 pb-20">
    <PageHeader eyebrow="Endpoint inventory" title={title} description="Recorded inventory and live connectivity are reported separately." actions={<>
      <button type="button" className="secondary-button" onClick={state.refresh}><RefreshCw size={16} />Refresh</button>
      {data && <DeviceLifecycleEditor assetId={assetId} detail={data} onSaved={state.refresh} />}
    </>} />
    <nav aria-label="Device navigation" className="overflow-x-auto border-b"><Tabs tabs={tabs} active={tab} onChange={setTab} /></nav>
    {tab !== 'Apps' && <section aria-label="Connectivity" className="card flex flex-wrap items-center gap-4 p-5">
      <AppWindow className="text-brand-600" size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-extrabold">{source === 'agent_heartbeat' ? 'Agent status' : 'Live connectivity'}</h2>
          <Badge tone={connected === true ? 'green' : connected === false ? 'rose' : 'amber'}>{status}</Badge>
          {connectivity.loading && <span className="text-xs text-slate-500">Checking connectivity…</span>}
        </div>
        <p className="mt-2 break-words text-xs text-slate-500">Source: {sourceLabel} · Checked at: {recorded(connectivity.data?.connectivityCheckedAt)}</p>
        {source === 'agent_heartbeat' && <>
          <p className="mt-1 break-words text-xs text-slate-500">Last heartbeat: {connectivity.data?.lastHeartbeatAt || 'Not received'}</p>
        </>}
        {connectivity.error && <p role="alert" className="mt-2 text-xs text-amber-700">Connectivity unavailable. {connectivity.error}</p>}
      </div>
    </section>}
    {detail.loading && <p role="status" className="text-sm text-slate-500">Loading device details…</p>}
    {detail.error && <p role="alert" className="card p-4 text-rose-700">Device details unavailable. {detail.error}</p>}
    {data && tab !== 'Apps' && <InfoSection title="Inventory freshness" fields={[
      ['Device report', inventoryReportFreshness(data.lastSeenAt)],
      ['Hardware', inventoryFreshness(data.collectionStatus?.hardware)],
      ['Applications list', inventoryFreshness(data.collectionStatus?.software)],
      ['Services list', inventoryFreshness(data.collectionStatus?.services)],
      ['Updates scan', inventoryFreshness(data.collectionStatus?.updates)],
      ['Network', inventoryFreshness(data.collectionStatus?.network)],
    ]} />}
    {data && tab !== 'Apps' && <InfoSection title="Assignment" fields={[
      ['User', data.user?.fullName], ['Email', data.user?.email], ['Department', data.department?.name],
      ['Location', data.branch?.name], ['System ID', assetId], ['Computer Type', data.deviceType],
    ]} />}
    {data && tab === 'Apps' && <section aria-label="Device apps" className="space-y-4"><Suspense fallback={<p role="status">Loading apps...</p>}><AppsServicesPanel appsOnly systemView assetId={assetId} /></Suspense></section>}
    {data && tab === 'Overview' && <InfoSection title="Inventory overview" fields={[
      ['Compliance', data.complianceScore == null ? undefined : `${data.complianceScore}%`],
      ['Patch Status', data.patchStatus], ['Operating System', data.osName], ['OS Version', data.osVersion],
      ['Memory', data.memory], ['Processor', data.processor], ['Last inventory report', data.lastSeenAt], ['Architecture', data.architecture],
    ]} />}
    {data && tab === 'System' && <div className="space-y-4">
      {systemSections(data).map(section => <InfoSection key={section.title} {...section} />)}
      <InfoSection title="Remote access" copyIDs fields={[[ 'AnyDesk ID', data.anydeskId ], [ 'RustDesk ID', data.rustdeskId ]]} />
      <p className="text-sm text-slate-500">Recorded IDs only. Copying an ID does not start a remote session.</p>
      <InfoSection {...networkSection(data)} />
      <p className="text-sm text-slate-500">Network details and interface state are from stored inventory, not a live network scan.</p>
      {interfaces.length ? interfaces.map((section, index) => <InfoSection key={`${section.title}:${index}`} {...section} />)
        : <InfoSection title="Network interfaces" fields={[[ 'Interface statistics', undefined ]]} />}
    </div>}
    {data && tab === 'Services' && <section aria-label="Recorded device services" className="space-y-3">
      <p className="text-sm">{inventoryFreshness(data.collectionStatus?.services)} · Last successful receipt: {data.servicesLastSuccessAt || 'Not recorded'}</p>
      <p className="text-xs text-slate-500">{data.collectionStatus?.services?.scope || 'Scope not reported'} · Source: {data.collectionStatus?.services?.source || 'Not recorded'}</p>
      <Suspense fallback={<p role="status">Loading services...</p>}><AppsServicesPanel servicesOnly assetId={assetId} /></Suspense>
    </section>}
    {data && tab === 'Updates' && <section aria-label="Pending updates" className="space-y-3">
      <h2 className="font-extrabold">Pending updates</h2>
      <p className="mt-2 text-sm">{inventoryFreshness(data.collectionStatus?.updates)} · Pending updates: {data.pendingUpdates ?? 'Unknown'}</p>
      <p className="text-sm text-slate-500">Last scan: {recorded(data.updateScannedAt)} · Reboot required: {data.rebootRequired === true ? 'Yes' : data.rebootRequired === false ? 'No' : 'Unknown'}</p>
      {data.pendingUpdateDetails?.length ? <ul className="divide-y border-y">{data.pendingUpdateDetails.map((update, index) => <li key={`${index}:${update}`} className="break-words py-3 text-sm">{update}</li>)}</ul>
        : <p className="text-sm">{data.pendingUpdates === 0 && (data.updateScanStatus || data.collectionStatus?.updates?.status) === 'success' ? 'No pending updates reported by the last successful scan.' : 'Pending update details are not available.'}</p>}
    </section>}
    {tab === 'Alerts' && <section aria-label="Device alerts">
      {alerts.loading ? <p role="status">Loading alerts…</p> : alerts.error ? <p role="alert">Alerts unavailable. {alerts.error}</p> : alerts.data && <div className="table-shell overflow-x-auto"><table className="data-table">
        <thead><tr><th>Source</th><th>Finding</th><th>Severity</th><th>Status</th></tr></thead>
        <tbody>{alerts.data.length ? alerts.data.map((alert, index) => <tr key={alert.id ?? index}>
          <td>{recorded(alert.source)}</td><td><strong>{recorded(alert.title)}</strong><p className="text-xs text-slate-500">{recorded(alert.detail)}</p></td>
          <td>{recorded(alert.severity)}</td><td>{alert.resolved === true ? 'Resolved' : alert.resolved === false ? 'Open' : 'Not recorded'}</td>
        </tr>) : <tr><td colSpan={4} className="py-10 text-center text-slate-500">No endpoint alerts.</td></tr>}</tbody>
      </table></div>}
    </section>}
    {tab === 'History' && <section aria-label="Device history">
      {history.loading ? <p role="status">Loading history…</p> : history.error ? <p role="alert">History unavailable. {history.error}</p> : history.data && <div className="table-shell overflow-x-auto"><table className="data-table">
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th></tr></thead>
        <tbody>{history.data.length ? history.data.map((item, index) => <tr key={item.id ?? index}>
          <td>{recorded(item.created_at)}</td><td>{recorded(item.actor)}</td><td className="font-bold">{recorded(item.action)}</td>
        </tr>) : <tr><td colSpan={3} className="py-10 text-center text-slate-500">No endpoint history.</td></tr>}</tbody>
      </table></div>}
    </section>}
  </div>
}