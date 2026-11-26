import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ClipboardCheck, Download, Play, RefreshCw, Search, Square, ToggleLeft, ToggleRight, Trash2, Wrench } from 'lucide-react'
import { Badge } from '../components/ui'
import { EndpointActionDialog as Modal } from '../components/EndpointActionDialog'
import { getToken, isAdminRole, subscribeAuth, useAuthToken } from '../lib/auth'
import { inventoryFreshness, inventoryReportFreshness } from '../lib/inventoryFreshness'
import {
  EndpointApiError, catalogInputError, endpointRequest, isDesktopApplication, journalKey, mergeRecords, message, normalizeRecord, normalizeScriptRecord, packageOS, readJournal, recordKey, secureUUID, useEndpointResource, vendorKey,
  type ActionChoice, type ActionHistory, type ActionRecord, type CatalogApplication, type CatalogPage,
  type CollectionSection, type DeviceInventory, type LiveServices, type PatchEndpoint, type SoftwarePermissions,
  type InstallationScript, type InstallationScriptPage, type SoftwareApprovals, type VendorVersions,
} from '../lib/appsServices'

export function AppsServicesPanel({ appsOnly = false, servicesOnly = false, systemView = false, assetId }: { appsOnly?: boolean; servicesOnly?: boolean; systemView?: boolean; assetId?: string }) {
  const token = useAuthToken()
  return token ? <AccountWorkspace key={`${token}:${assetId || ''}:${servicesOnly}`} token={token} appsOnly={appsOnly || servicesOnly} servicesOnly={servicesOnly} systemView={systemView} targetAssetId={assetId} /> : <p role="alert">Sign in to view {servicesOnly ? 'Services' : appsOnly ? 'Apps' : 'Apps & Services'}.</p>
}

function AccountWorkspace({ token, appsOnly, servicesOnly, systemView, targetAssetId }: { token: string; appsOnly: boolean; servicesOnly: boolean; systemView: boolean; targetAssetId?: string }) {
  const me = useEndpointResource<{ id: string; role: string }>(token, '/auth/me')
  const readable = !!me.data?.id && ['super_admin', 'admin', 'it_team', 'auditor'].includes(me.data.role)
  // The scoped inventory directory also permits admin/auditor readers; the
  // patch execution directory is restricted to super_admin/it_team.
  const devices = useEndpointResource<PatchEndpoint[]>(token, readable && !targetAssetId ? '/devices' : null)
  const [assetId, setAssetId] = useState('')
  const device = devices.data?.find(item => item.id === assetId)
  if (readable && targetAssetId) return <DeviceWorkspace token={token} accountId={me.data!.id} role={me.data!.role} assetId={targetAssetId} appsOnly={appsOnly} servicesOnly={servicesOnly} showServices={servicesOnly || !appsOnly} ticketed={servicesOnly || (appsOnly && systemView)} />
  return <section aria-label="Apps & Services" className="space-y-5">
    {!appsOnly && <div><h2 className="text-xl font-extrabold">Install / Remove Apps</h2><p className="mt-2 text-sm text-slate-500">Select a device, choose an approved package, then review install or remove and confirm. No command typing is required. Apps &amp; Services manages one authorized system at a time.</p></div>}
    {me.loading ? <p role="status">Checking account access…</p> : !readable ? <p role="alert">Apps &amp; Services unavailable. {me.error || 'This role does not have inventory management read access.'}</p> : <>
      {devices.error && <p role="alert">Devices unavailable: {devices.error}</p>}
      {systemView ? <div className="overflow-x-auto"><table className="data-table"><thead><tr><th>System name</th><th>Asset ID</th><th>Email ID</th><th>Apps</th></tr></thead><tbody>{devices.data?.map(item => <tr key={item.id}><td>{item.hostname || 'Not recorded'}</td><td>{item.assetId || item.assetTag || item.id}</td><td className="break-all">{item.user?.email || 'Unassigned'}</td><td><button className="secondary-button" aria-label={`Apps for ${item.hostname || item.id}`} aria-expanded={assetId === item.id} onClick={() => setAssetId(assetId === item.id ? '' : item.id)}>Apps</button></td></tr>)}</tbody></table></div> : <label className="block text-sm font-bold">Device<select className="field mt-2" value={assetId} onChange={event => setAssetId(event.target.value)} disabled={devices.loading || !devices.data?.length}>
        <option value="">{devices.loading ? 'Loading devices…' : 'Select a device'}</option>
        {devices.data?.map(item => <option key={item.id} value={item.id}>{item.assetTag ? `${item.assetTag} · ` : ''}{item.hostname || item.id}</option>)}
      </select></label>}
      {devices.loading && <p role="status">Loading authorized devices…</p>}
      {devices.data?.length === 0 && <p>No authorized devices available.</p>}
      {device && <section aria-label={`${servicesOnly ? 'Services' : appsOnly ? 'Apps' : 'Apps and services'} for ${device.hostname || device.id}`} className="space-y-4"><h2 className="text-lg font-bold">{device.hostname || device.id}</h2><DeviceWorkspace key={assetId} token={token} accountId={me.data!.id} role={me.data!.role} assetId={assetId} appsOnly={appsOnly} servicesOnly={servicesOnly} showServices={servicesOnly || !appsOnly || systemView} ticketed={servicesOnly || (appsOnly && systemView)} /></section>}
    </>}
  </section>
}

function Coverage({ title, section }: { title: string; section?: CollectionSection }) {
  return <div className="rounded-md border p-3 text-xs leading-6">
    <strong>{title} collection: {section?.status || 'uncollected'}</strong>
    <p>{title} list: {inventoryFreshness(section)}</p>
    <p>Source: {section?.source || 'Not recorded'} · Scanned: {section?.scanned_at || 'Not recorded'}</p>
    <p>Scope: {section?.scope || 'Not reported; completeness not guaranteed'}</p>
    <p>Returned: {section?.returned ?? 'Not reported'} / Total: {section?.total ?? 'Not reported'} · Truncation: {section?.truncated || section?.truncated_count ? `Yes (${section.truncated_count ?? 'count not reported'} omitted)` : section?.truncated === false ? 'No' : 'Not reported'}</p>
    {section?.error && <p role="alert">{section.error}</p>}
  </div>
}

function DeviceWorkspace({ token, accountId, role, assetId, appsOnly, showServices, servicesOnly, ticketed = appsOnly && showServices }: { token: string; accountId: string; role: string; assetId: string; appsOnly: boolean; showServices: boolean; servicesOnly: boolean; ticketed?: boolean }) {
  const [revision, setRevision] = useState(0)
  const detail = useEndpointResource<DeviceInventory>(token, `/devices/${encodeURIComponent(assetId)}`, revision)
  if (detail.loading) return <p role="status">Loading stored inventory…</p>
  if (detail.error || !detail.data || detail.data.id !== assetId || !detail.data.entityId) return <p role="alert">Inventory unavailable: {detail.error || 'Missing authorized device scope.'}</p>
  return <EndpointControls key={`${detail.data.entityId}:${detail.data.osName}`} token={token} accountId={accountId} role={role} device={detail.data} appsOnly={appsOnly} servicesOnly={servicesOnly} showServices={showServices} ticketed={ticketed} refreshInventory={() => setRevision(value => value + 1)} />
}

function EndpointControls({ token, accountId, role, device, refreshInventory, appsOnly, showServices, servicesOnly, ticketed }: { token: string; accountId: string; role: string; device: DeviceInventory; refreshInventory: () => void; appsOnly: boolean; showServices: boolean; servicesOnly: boolean; ticketed: boolean }) {
  const assetPath = `/assets/${encodeURIComponent(device.id)}`
  const [revision, setRevision] = useState(0)
  const permissions = useEndpointResource<SoftwarePermissions>(token, '/software/permissions', revision)
  const management = useEndpointResource<ActionHistory>(token, `${assetPath}/management-actions`, revision)
  const installs = useEndpointResource<ActionHistory>(token, `${assetPath}/software-installs`, revision)
  const scriptRuns = useEndpointResource<ActionHistory>(token, `${assetPath}/script-runs`, revision)
  const [scriptPage, setScriptPage] = useState(1)
  const scripts = useEndpointResource<InstallationScriptPage>(token, appsOnly ? null : `${assetPath}/installation-scripts?page=${scriptPage}`, revision)
  const [scriptId, setScriptId] = useState('')
  const [scriptApproved, setScriptApproved] = useState(false)
  const live = useEndpointResource<LiveServices>(token, showServices ? `${assetPath}/services` : null, revision)
  const [page, setPage] = useState(1)
  const [catalogRevision, setCatalogRevision] = useState(0)
  const os = packageOS(device.osName)
  const approvals = useEndpointResource<SoftwareApprovals>(token, servicesOnly ? null : `${assetPath}/software-approvals`, revision)
  const versions = useEndpointResource<VendorVersions>(token, !servicesOnly && ticketed && os ? `/software/vendor-versions?os=${os}` : null, revision)
  const catalog = useEndpointResource<CatalogPage>(token, servicesOnly ? null : `/software/catalog?entityId=${encodeURIComponent(device.entityId)}${os ? `&os=${os}` : ''}&active=true&page=${page}`, revision + catalogRevision)
  const refreshCatalog = () => { setPage(1); setCatalogRevision(value => value + 1) }
  const [application, setApplication] = useState<CatalogApplication | null>(null)
  const [serviceName, setServiceName] = useState('')
  const [serviceAction, setServiceAction] = useState<'start' | 'stop' | 'restart' | 'enable' | 'disable'>('restart')
  const [serviceSearch, setServiceSearch] = useState('')
  const [confirmation, setConfirmation] = useState<ActionChoice | null>(null)
  const key = journalKey(accountId, device.entityId, device.id)
  const [journal, setJournal] = useState(() => readJournal(key, device.id))
  const journalRef = useRef(journal)
  const controller = useRef<AbortController | null>(null)
  const lock = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [blocked, setBlocked] = useState(false)
  useEffect(() => {
    const request = new AbortController()
    controller.current = request
    const unsubscribe = subscribeAuth(() => { if (getToken() !== token) request.abort() })
    return () => { request.abort(); unsubscribe() }
  }, [token])

  const desktopApps = device.installedApps?.filter(isDesktopApplication) || []
  const applications = catalog.data?.items.filter(item => item.active && item.entityId === device.entityId && item.os === os && desktopApps.some(app => app.name === item.packageName || app.name === item.name)) || []
  const remoteRecords = [
    ...(installs.data?.items || []).map(item => ({ ...item, kind: 'software' as const, action: 'install' })),
    ...(management.data?.items || []),
    ...(scriptRuns.data?.items || []).map(item => normalizeScriptRecord(item, device.id)),
  ].filter(item => item.assetId === device.id)
  // Local status checks can be newer than the history loaded on mount.
  const records = mergeRecords(remoteRecords, journal)
  const unresolved = records.some(item => item.status === 'unknown')
  const historiesReady = !!installs.data && !!management.data && !!scriptRuns.data && !installs.loading && !management.loading && !scriptRuns.loading && !installs.error && !management.error && !scriptRuns.error
  const mutable = (role === 'super_admin' || role === 'it_team') && permissions.data?.canInstall === true && historiesReady && !blocked && !busy && !unresolved
  const installApproval = approvals.data?.items.find(item => item.available && item.applicationId === application?.id && item.packageName === application.packageName && item.action === 'install')
  const removeApproval = approvals.data?.items.find(item => item.available && item.applicationId === application?.id && item.packageName === application.packageName && item.action === 'remove')
  const softwareAllowed = (candidate: CatalogApplication | null | undefined, action: 'install' | 'remove') => mutable && !!candidate && applications.some(item => item.id === candidate.id && item.packageName === candidate.packageName) && !catalog.loading && !catalog.error && !approvals.loading && !approvals.error && catalog.data?.capabilities.canInstall === true && (action === 'install' ? installs.data?.capabilities.canInstall === true : management.data?.capabilities.canManage === true) && !!approvals.data?.items.some(item => item.available && item.applicationId === candidate.id && item.packageName === candidate.packageName && item.action === action)
  const canInstall = softwareAllowed(application, 'install')
  const canRemove = softwareAllowed(application, 'remove')
  const serviceAllowed = (name: string) => mutable && !live.loading && !live.error && management.data?.capabilities.canManage === true && live.data?.capabilities.canManage === true && ['success', 'partial'].includes(live.data.status) && !!live.data.items.find(item => item.name === name)
  const canService = serviceAllowed(serviceName)
  const CatalogContainer = ticketed ? 'details' : 'section'
  const serviceKey = (name: string) => os === 'linux' ? name.replace(/\.service$/, '') : name
  const recordedServices = new Map(device.services?.map(service => [serviceKey(service.name), service]))
  const liveNames = new Set(live.data?.items.map(service => serviceKey(service.name)))
  const serviceRows = [
    ...(live.data?.items.map(service => ({ name: service.name, recorded: recordedServices.get(serviceKey(service.name)) })) || []),
    ...(device.services?.filter(service => !liveNames.has(serviceKey(service.name))).map(service => ({ name: service.name, recorded: service })) || []),
  ].filter(service => `${service.name} ${service.recorded?.display_name || ''}`.toLowerCase().includes(serviceSearch.trim().toLowerCase()))
  const compatibleScripts = scripts.data?.items.filter(item => item.type === 'sh' && (item.entityId === '' || item.entityId === device.entityId)) || []
  const selectedScript = compatibleScripts.find(item => item.id === scriptId)
  const canScript = mutable && isAdminRole(role) && scripts.data?.capabilities.canApply === true && scriptRuns.data?.capabilities.canApply === true && !!selectedScript && !scripts.error && !scripts.loading
  const allowed = (choice: ActionChoice) => choice.kind === 'script'
    ? canScript && scriptApproved && choice.script.hash === selectedScript?.hash && choice.script.id === scriptId
    : choice.kind === 'service'
    ? canService && choice.serviceName === serviceName && choice.action === serviceAction
    : choice.application.id === application?.id && choice.application.packageName === application.packageName && (choice.action === 'install' ? canInstall : canRemove)

  function saveRecord(record: ActionRecord) {
    const next = mergeRecords(journalRef.current, [record])
    // Persist before dispatch: if storage is unavailable, no mutation is sent.
    sessionStorage.setItem(key, JSON.stringify(next))
    journalRef.current = next
    setJournal(next)
  }

  async function reviewScript() {
    const signal = controller.current?.signal
    if (!canScript || !selectedScript || !signal || signal.aborted || lock.current) return
    lock.current = true; setBusy(true); setError(''); setScriptApproved(false)
    try {
      const script = await endpointRequest<InstallationScript>(token, `${assetPath}/installation-scripts/${encodeURIComponent(selectedScript.id)}`, signal)
      if (script.id !== selectedScript.id || script.entityId !== selectedScript.entityId || script.type !== 'sh' || script.hash !== selectedScript.hash) throw new Error('Script changed. Refresh the catalog and review again.')
      setConfirmation({ kind: 'script', action: 'apply', script })
    } catch (failure) {
      if (!signal.aborted && getToken() === token) setError(message(failure))
    } finally {
      if (!signal.aborted && getToken() === token) { lock.current = false; setBusy(false) }
    }
  }

  async function execute() {
    const choice = confirmation
    const signal = controller.current?.signal
    if (!choice || !signal || signal.aborted || getToken() !== token || lock.current || !allowed(choice)) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    let pending: ActionRecord | undefined
    try {
      const requestId = secureUUID()
      const now = new Date().toISOString()
      const reservation: ActionRecord = { requestId, assetId: device.id, kind: choice.kind, action: choice.action, status: 'unknown', outcomeCode: 'response_unavailable', createdAt: now, updatedAt: now,
        ...(choice.kind === 'software' ? { applicationId: choice.application.id, applicationName: choice.application.name, packageName: choice.application.packageName } : choice.kind === 'script' ? { scriptId: choice.script.id, scriptHash: choice.script.hash, scriptName: choice.script.name, category: choice.script.category } : { serviceName: choice.serviceName }) }
      saveRecord(reservation)
      pending = reservation
      setConfirmation(null)
      const install = choice.kind === 'software' && choice.action === 'install'
      const script = choice.kind === 'script'
      const body = script ? { scriptId: pending.scriptId, scriptHash: pending.scriptHash, requestId, confirmed: true } : install ? { applicationId: pending.applicationId, approvalId: installApproval!.id, requestId, confirmed: true } : {
        requestId, kind: choice.kind, action: choice.action, ...(choice.kind === 'software' ? { applicationId: pending.applicationId, approvalId: removeApproval!.id } : { serviceName: choice.serviceName }), confirmed: true,
      }
      const result = await endpointRequest<{ install?: ActionRecord; run?: ActionRecord; items?: ActionRecord[]; capabilities?: { canManage: boolean }; outcomePersistenceUnconfirmed?: boolean }>(token, `${assetPath}/${script ? 'script-runs' : install ? 'software-install' : 'management-actions'}`, signal, body)
      const record = script ? normalizeScriptRecord(result.run!, device.id) : normalizeRecord((install ? result.install : result.items?.find(item => item.requestId === requestId))!, device.id, install)
      if (record.requestId !== requestId || record.kind !== pending.kind || record.action !== pending.action ||
        record.applicationId !== pending.applicationId || record.serviceName !== pending.serviceName || record.scriptId !== pending.scriptId || record.scriptHash !== pending.scriptHash) throw new Error('Unexpected action identity. Check status only.')
      if (result.outcomePersistenceUnconfirmed) throw new Error('Outcome persistence unconfirmed. Check status only.')
      saveRecord({ ...pending, ...record })
        if (choice.kind === 'software') setRevision(value => value + 1)
      if (!install && !script && result.capabilities?.canManage !== true) setBlocked(true)
      setNotice(`Action ${record.status}: ${record.outcomeCode}. Stored inventory has not been refreshed by this action.`)
    } catch (failure) {
      if (signal.aborted || getToken() !== token) return
      if (failure instanceof EndpointApiError && [401, 403, 404, 503].includes(failure.status)) setBlocked(true)
      // HTTP rejection is not a stored endpoint outcome (409 may refer to an
      // existing request). Retain uncertainty until an exact status read resolves it.
      setError(`${message(failure)} ${!pending ? 'Request preparation failed; no action was sent. Browser session storage and secure UUID generation are required.' : 'Outcome unknown. Request ID retained; check status only. Do not repeat the action. No automatic retry was made.'}`)
    } finally {
      if (!signal.aborted && getToken() === token) { lock.current = false; setBusy(false) }
    }
  }

  async function checkStatus(record: ActionRecord) {
    const signal = controller.current?.signal
    if (!signal || signal.aborted || getToken() !== token || lock.current) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const install = record.action === 'install'
      const script = record.kind === 'script'
      const result = await endpointRequest<ActionHistory>(token, `${assetPath}/${script ? 'script-runs' : install ? 'software-installs' : 'management-actions'}?requestId=${encodeURIComponent(record.requestId)}`, signal)
      if ((script ? result.capabilities.canApply : install ? result.capabilities.canInstall : result.capabilities.canManage) !== true) setBlocked(true)
      const found = result.items.find(item => item.requestId === record.requestId)
      if (found) {
        const updated = script ? normalizeScriptRecord(found, device.id) : normalizeRecord(found, device.id, install)
        if (updated.kind !== record.kind || updated.action !== record.action || updated.applicationId !== record.applicationId || updated.serviceName !== record.serviceName || updated.scriptId !== record.scriptId || updated.scriptHash !== record.scriptHash) throw new Error('Status identity does not match this request.')
        saveRecord({ ...record, ...updated }); setNotice(`Status: ${updated.status} · ${updated.outcomeCode}`)
      }
      else setNotice('No durable result found. Outcome remains unknown; do not resubmit. Investigate using the retained request ID.')
    } catch (failure) {
      if (!signal.aborted && getToken() === token) { setError(`Status unavailable: ${message(failure)} The request ID is retained; no action was resubmitted.`); if (failure instanceof EndpointApiError && [401, 403, 404].includes(failure.status)) setBlocked(true) }
    } finally { if (!signal.aborted && getToken() === token) { lock.current = false; setBusy(false) } }
  }

  return <div className="space-y-5">
    {!appsOnly && <div className="card space-y-3 p-5"><h3 className="font-extrabold">{device.assetTag || device.hostname || device.id}</h3><p className="break-all text-xs">Device ID: {device.id} · Entity: {device.entityId} · OS: {device.osName || 'Not recorded'}</p>
      <p className="text-sm text-slate-500">Stored inventory may be stale or incomplete. Management does not trigger collection or update these observations. Collection timing and coverage depend on the installed agent, platform and permissions—not all apps or services are guaranteed.</p>
      <p className="text-xs">Last inventory report: {device.lastSeenAt || 'Not recorded'} · Services last successful collection: {device.servicesLastSuccessAt || 'Not recorded'} · Services updated: {device.servicesUpdatedAt || 'Not recorded'}</p>
      <p className="text-sm font-semibold">Device information: {inventoryReportFreshness(device.lastSeenAt)}</p>
      <div className="flex flex-wrap gap-2"><button className="secondary-button" disabled={busy} onClick={refreshInventory}>Refresh stored inventory</button><button className="secondary-button" disabled={busy} onClick={() => { setBlocked(false); setRevision(value => value + 1) }}>Refresh capabilities &amp; live data</button></div>
    </div>}
    {permissions.error && <p role="alert">Permissions unavailable: {permissions.error}</p>}
    {(permissions.loading || installs.loading || management.loading) && <p role="status">Checking device capabilities and action history…</p>}
    {(!['super_admin', 'it_team'].includes(role) || permissions.data?.canInstall === false) && <p role="status">Read-only access. Endpoint changes require server-granted install/manage capabilities.</p>}
    {busy && <p role="status">Request in progress. Endpoint actions are locked; leaving does not cancel a dispatched action.</p>}
    {error && <p role="alert" className="rounded-md border border-rose-200 p-4 text-sm text-rose-700">{error}</p>}
    {notice && <p role="status" className="rounded-md border p-4 text-sm">{notice}</p>}
    {unresolved && <p role="alert">An outcome is unknown. New actions on this device are locked until status is resolved. Status checks never retry mutations.</p>}
    {!appsOnly && <section aria-label="Installation scripts" className="space-y-4 border-y py-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-extrabold">Application &amp; service installation scripts</h3>{isAdminRole(role) && <a className="secondary-button" href="/admin/scripts">Manage scripts in Settings</a>}</div>
      {(scripts.error || scriptRuns.error) && <p role="alert">Installation scripts unavailable: {scripts.error || scriptRuns.error}</p>}
      {scripts.loading ? <p role="status">Loading compatible scripts...</p> : <label className="block text-sm font-bold">Installation script<select className="field mt-2" value={selectedScript?.id || ''} disabled={busy} onChange={event => setScriptId(event.target.value)}><option value="">Select an installation script</option>{compatibleScripts.map(item => <option key={item.id} value={item.id}>{item.name} · {item.category} · {item.os} ({item.type})</option>)}</select></label>}
      {selectedScript?.description && <p className="text-sm">{selectedScript.description}</p>}
      {scripts.data && !compatibleScripts.length && <p>No compatible saved scripts for this device.</p>}
      {!isAdminRole(role) && <p className="text-sm">Script execution requires admin access.</p>}
      <div className="flex flex-wrap items-center gap-3"><button className="secondary-button" disabled={scriptPage === 1 || scripts.loading || busy} onClick={() => { setScriptId(''); setScriptPage(value => value - 1) }}>Previous scripts</button><span className="text-xs">Script page {scriptPage}</span><button className="secondary-button" disabled={!scripts.data?.hasMore || scripts.loading || busy} onClick={() => { setScriptId(''); setScriptPage(value => value + 1) }}>Next scripts</button><button className="primary-button" disabled={!canScript} onClick={() => void reviewScript()}>Review installation script</button></div>
    </section>}
    <div className={appsOnly ? 'flex min-w-0 flex-col gap-5' : 'grid gap-5 xl:grid-cols-2'}>
        {!servicesOnly && <CatalogContainer aria-label="Approved applications" role="region" className={appsOnly ? 'space-y-3 border-t pt-4' : 'card space-y-4 p-5'}>{ticketed ? <summary className="cursor-pointer text-sm font-semibold"><Wrench size={16} className="mr-2 inline" />Catalog &amp; approvals</summary> : <h3 className="font-extrabold">{appsOnly ? 'Install / Remove' : 'Approved applications'}</h3>}
        {!appsOnly && <p className="text-sm text-slate-500">Only active catalog packages matching this device’s entity and OS can be installed or removed. Inventory names are not package approval.</p>}
        {catalog.error && <p role="alert">Catalog unavailable: {catalog.error}</p>}
        {!os && <p role="alert">Unsupported or unrecorded OS. Package actions are unavailable.</p>}
        {catalog.loading ? <p role="status">Loading catalog…</p> : <label className="block text-sm font-bold">Approved package<select className="field mt-2" value={applications.some(item => item.id === application?.id) ? application!.id : ''} onChange={event => setApplication(applications.find(item => item.id === event.target.value) || null)}>
          <option value="">Select an approved package</option>{applications.map(item => <option key={item.id} value={item.id}>{item.name} · {item.packageName} ({item.os})</option>)}
        </select></label>}
        {catalog.data && !applications.length && <p>No approved desktop apps match this device on this catalog page.</p>}
          {approvals.error && <p role="alert">Ticket approvals unavailable: {approvals.error}</p>}
          {application && <div className="space-y-2 text-sm"><p>Install approval ticket: {installApproval?.ticketNumber || 'Required'}</p><p>Remove approval ticket: {removeApproval?.ticketNumber || 'Required'}</p></div>}
          {application && isAdminRole(role) && approvals.data?.canApprove && <ApproveSoftwareTicket key={`${application.id}:${revision}`} token={token} assetPath={assetPath} application={application} disabled={!mutable || approvals.loading} onApproved={() => setRevision(value => value + 1)} />}
          <button className="secondary-button" disabled={busy || approvals.loading} onClick={() => setRevision(value => value + 1)}>Refresh approvals</button>
        {role === 'super_admin' && os && <AddApprovedApplication token={token} device={device} os={os} canCreate={permissions.data?.canManageCatalog === true} catalogRevision={revision + catalogRevision} catalogReady={!catalog.loading && !!catalog.data && !catalog.error} refreshCatalog={refreshCatalog} onCreated={() => { setApplication(null); refreshCatalog() }} />}
        <button className="secondary-button" disabled={catalog.loading || busy} onClick={refreshCatalog}>Refresh catalog</button>
        {(!ticketed || page > 1 || catalog.data?.hasMore) && <div className="flex items-center gap-3"><button className={ticketed ? 'icon-button' : 'secondary-button'} aria-label="Previous catalog page" title="Previous catalog page" disabled={page === 1 || catalog.loading || busy} onClick={() => { setApplication(null); setPage(value => value - 1) }}>{ticketed ? <ChevronLeft size={16} /> : 'Previous catalog page'}</button><span className="text-xs">Page {page}</span><button className={ticketed ? 'icon-button' : 'secondary-button'} aria-label="Next catalog page" title="Next catalog page" disabled={!catalog.data?.hasMore || busy} onClick={() => { setApplication(null); setPage(value => value + 1) }}>{ticketed ? <ChevronRight size={16} /> : 'Next catalog page'}</button></div>}
        <div className="flex flex-wrap gap-2"><button className="primary-button" disabled={!canInstall} onClick={() => application && setConfirmation({ kind: 'software', action: 'install', application })}>Review install</button><button className="secondary-button" disabled={!canRemove} onClick={() => application && setConfirmation({ kind: 'software', action: 'remove', application })}>Review remove</button></div>
      </CatalogContainer>}
      {showServices && ticketed && <section aria-label="Live service controls" className="min-w-0 space-y-3 border-t pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-extrabold">Services</h3><div className="flex max-w-full items-center gap-2"><label className="relative min-w-0"><Search size={16} className="pointer-events-none absolute left-3 top-3 text-slate-500" /><input type="search" aria-label="Search services" placeholder="Search services" className="field w-56 max-w-full pl-9" value={serviceSearch} onChange={event => setServiceSearch(event.target.value)} /></label><button className="icon-button shrink-0" aria-label="Refresh services" title="Refresh services" disabled={busy || live.loading} onClick={() => { setBlocked(false); setRevision(value => value + 1); refreshInventory() }}><RefreshCw size={16} /></button></div></div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500"><span>Live names: {live.loading ? 'Loading...' : live.data?.status || 'unavailable'}</span><span>Recorded states: {device.servicesLastSuccessAt ? new Date(device.servicesLastSuccessAt).toLocaleString() : 'Not recorded'}</span></div>
        {(live.error || live.data?.status === 'unavailable') && <p role="alert">Live services unavailable: {live.error || live.data?.error || 'No live response'}</p>}
        <div role="region" aria-label="Recorded services" className="max-h-96 overflow-auto"><table className="data-table"><thead><tr><th>Name</th><th>Recorded state</th><th>Recorded start mode</th><th>Actions</th></tr></thead><tbody>{serviceRows.map(service => <tr key={service.name}><td>{service.name}</td><td>{service.recorded?.state || 'Not recorded'}</td><td>{service.recorded?.start_mode || 'Not recorded'}</td><td><div className="flex w-max items-center gap-1">{([
          ['start', 'Start', Play], ['stop', 'Stop', Square], ['restart', 'Restart', RefreshCw], ['enable', 'Enable', ToggleRight], ['disable', 'Disable', ToggleLeft],
        ] as const).map(([action, label, Icon]) => <span key={action} title={serviceAllowed(service.name) ? `${label} ${service.name}` : 'Live service access and action permissions required'}><button className="icon-button h-8 w-8" aria-label={`${label} service ${service.name}`} title={`${label} service`} disabled={!serviceAllowed(service.name)} onClick={() => { setServiceName(service.name); setServiceAction(action); setConfirmation({ kind: 'service', action, serviceName: service.name }) }}><Icon size={16} /></button></span>)}</div></td></tr>)}</tbody></table>{!serviceRows.length && <p className="py-3 text-sm">{serviceSearch ? 'No matching services.' : live.loading ? 'Loading services...' : 'No services available.'}</p>}</div>
      </section>}
      {showServices && !ticketed && <section aria-label="Live service controls" className={appsOnly ? 'space-y-4 border-t pt-5' : 'card space-y-4 p-5'}><h3 className="font-extrabold">Live service controls</h3>
        <p className="text-sm text-slate-500">Stop/disable is not service deletion. Removing the owning approved application is a separate package operation. Protected management components may be rejected by the server.</p>
        <p>Listing: {live.loading ? 'Loading…' : live.data?.status || 'unavailable'}</p>{(live.error || live.data?.error) && <p role="alert">{live.error || live.data?.error}</p>}
        {live.data?.status === 'success' && !live.data.items.length && <p>No supported live service names found. This does not prove the device has no services.</p>}
        <p className="text-xs text-slate-500">Restart acknowledgement does not prove process health. Running and enabled states remain unknown unless actually reported.</p>
        <label className="block text-sm font-bold">Live service<select className="field mt-2" value={serviceName} onChange={event => setServiceName(event.target.value)}><option value="">Select a live service name</option>{live.data?.items.map(item => <option key={item.name} value={item.name}>{item.name} · Running: {item.running == null ? 'Unknown' : item.running ? 'Yes' : 'No'} · Enabled: {item.enabled == null ? 'Unknown' : item.enabled ? 'Yes' : 'No'}</option>)}</select></label>
        <label className="block text-sm font-bold">Service action<select className="field mt-2" value={serviceAction} onChange={event => setServiceAction(event.target.value as typeof serviceAction)}>{['start', 'stop', 'restart', 'enable', 'disable'].map(action => <option key={action} value={action}>{action}</option>)}</select></label>
        <button className="primary-button" disabled={!canService} onClick={() => setConfirmation({ kind: 'service', action: serviceAction, serviceName })}>Review service action</button>
      </section>}
      {!servicesOnly && <section aria-label="Recorded applications" className={appsOnly ? 'order-first min-w-0 space-y-3' : 'card min-w-0 space-y-4 p-5'}><div className="flex items-center justify-between gap-3"><h3 className="font-extrabold">{appsOnly ? 'Apps' : 'Detected desktop apps'}</h3>{appsOnly && <button className="secondary-button" disabled={busy} onClick={() => { setBlocked(false); setRevision(value => value + 1); refreshInventory() }}>Refresh apps</button>}</div>{!appsOnly && <Coverage title="Software" section={device.collectionStatus?.software} />}
        {ticketed && versions.error && <p role="alert">Latest versions unavailable: {versions.error}</p>}
        <div className="max-h-96 overflow-auto"><table className="data-table"><thead><tr><th>Name</th><th>{ticketed ? 'Current version' : 'Version'}</th>{ticketed && <><th>Latest vendor version</th><th>Approval ticket number</th><th>Actions</th></>}{!appsOnly && <th>Source</th>}</tr></thead><tbody>{desktopApps.map((app, index) => {
          const latest = versions.data?.items[vendorKey(app.name)]
          const tickets = approvals.data?.items.filter(item => item.packageName === app.name) || []
          const candidates = applications.filter(item => item.packageName === app.name || item.name === app.name)
          const candidate = candidates.length === 1 ? candidates[0] : undefined
          return <tr key={app.id || index}>
            <td>{app.name}</td><td>{app.version || 'Not recorded'}</td>
            {ticketed && <>
              <td>{versions.loading ? 'Checking...' : latest?.status === 'available' ? <a href={latest.sourceUrl} target="_blank" rel="noreferrer" title={`Vendor release checked ${latest.checkedAt}`}>{latest.version}</a> : 'Unavailable'}</td>
              <td>{tickets.length ? tickets.map(ticket => <span className="block" key={ticket.id}>{ticket.ticketNumber} ({ticket.action}, {ticket.available ? 'approved' : ticket.requestId ? 'used' : 'unavailable'})</span>) : approvals.loading ? 'Loading...' : approvals.error ? 'Unavailable' : 'No linked approval'}</td>
              <td><div className="flex w-max items-center gap-1">
                {(['install', 'remove'] as const).map(action => <span key={action} title={softwareAllowed(candidate, action) ? `${action === 'install' ? 'Install' : 'Remove'} ${app.name}` : 'Matching catalog entry, ticket approval and action permissions required'}>
                  <button className="icon-button h-8 w-8" aria-label={`${action === 'install' ? 'Install' : 'Remove'} ${app.name}`} title={action === 'install' ? 'Install' : 'Remove'} disabled={!softwareAllowed(candidate, action)} onClick={() => { if (candidate) { setApplication(candidate); setConfirmation({ kind: 'software', action, application: candidate }) } }}>
                    {action === 'install' ? <Download size={16} /> : <Trash2 size={16} />}
                  </button>
                </span>)}
                {candidate && isAdminRole(role) && approvals.data?.canApprove && <ApproveSoftwareTicket compact key={`${candidate.id}:${revision}`} token={token} assetPath={assetPath} application={candidate} disabled={!mutable || approvals.loading} onApproved={() => setRevision(value => value + 1)} />}
              </div></td>
            </>}
            {!appsOnly && <td>{app.source || 'Not recorded'}</td>}
          </tr>
        })}</tbody></table></div>
        {!desktopApps.length && <p>No classified desktop apps recorded in this inventory.</p>}
      </section>}
      {showServices && !ticketed && <section aria-label="Recorded services" className={appsOnly ? 'min-w-0 space-y-4 border-t pt-5' : 'card min-w-0 space-y-4 p-5'}><h3 className="font-extrabold">Recorded services</h3>{!appsOnly && <Coverage title="Services" section={device.collectionStatus?.services} />}
        <div className="max-h-80 overflow-auto"><table className="data-table"><thead><tr><th>Name</th><th>State</th><th>Start mode</th><th>Source</th></tr></thead><tbody>{device.services?.map((service, index) => <tr key={`${service.name}:${index}`}><td>{service.name}{service.display_name && <small className="block">{service.display_name}</small>}</td><td>{service.state || 'Unknown'}</td><td>{service.start_mode || 'Unknown'}</td><td>{service.source || 'Not recorded'}</td></tr>)}</tbody></table></div>
        {!device.services?.length && <p>No services recorded. Service inventory requires the updated agent; older agents may not report it.</p>}
      </section>}
    </div>
    {(!appsOnly || unresolved || installs.error || management.error || scriptRuns.error) && <section aria-label="Action history" className={appsOnly ? 'space-y-3 border-t pt-4' : 'card space-y-4 p-5'}><h3 className="font-extrabold">{appsOnly ? 'Action needs attention' : 'Action history & status recovery'}</h3>{!appsOnly && <p className="text-xs text-slate-500">Latest 50 installs and 100 management actions, plus requests retained in this browser session. Status is the recorded outcome, not HTTP success.</p>}
      {installs.error && <p role="alert">Install history unavailable: {installs.error}</p>}{management.error && <p role="alert">Management actions unavailable: {management.error}</p>}
      {appsOnly && scriptRuns.error && <p role="alert">Action status unavailable: {scriptRuns.error}</p>}
      {records.filter(record => !appsOnly || record.status === 'unknown').map(record => <article className="space-y-2 rounded-md border p-3 text-sm" key={recordKey(record)}><div className="flex flex-wrap items-center gap-2"><strong>{record.action} · {record.scriptName || record.serviceName || record.applicationName || record.applicationId}</strong><Badge tone={record.status === 'succeeded' ? 'green' : record.status === 'failed' ? 'rose' : 'amber'}>{record.status}</Badge><span>{record.outcomeCode}</span></div><p className="break-all text-xs">Request ID: {record.requestId}</p><p className="text-xs">Created: {record.createdAt} · Updated: {record.updatedAt}</p><button className="secondary-button" disabled={busy} onClick={() => void checkStatus(record)}>Check status {record.requestId}</button></article>)}
      {!appsOnly && !records.length && <p>No action outcomes loaded.</p>}
    </section>}
    {confirmation && <Modal title="Confirm endpoint action" onClose={() => setConfirmation(null)}><div className="space-y-4 p-5"><p>Device: <strong>{device.assetTag || device.hostname}</strong> · {device.hostname} · {device.id}</p><p>Action: <strong>{confirmation.action}</strong></p>{confirmation.kind === 'software' ? <p>Approved application: {confirmation.application.name} · Package: <strong>{confirmation.application.packageName}</strong> · {confirmation.application.os} · {confirmation.application.id}</p> : confirmation.kind === 'script' ? <><p>{confirmation.script.name} · {confirmation.script.category} · {confirmation.script.os} ({confirmation.script.type})</p><p className="break-all text-xs">Version SHA-256: {confirmation.script.hash}</p><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 text-xs">{confirmation.script.body}</pre><p className="text-sm text-amber-700">Arbitrary commands run with the endpoint agent's privileges. Shell runtime is limited to 10 minutes. Completion does not verify installation. A browser timeout may occur first; use Check status, never resubmit.</p><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={scriptApproved} onChange={event => setScriptApproved(event.target.checked)} />I reviewed this script and approve applying this version to this device.</label></> : <p>Service: <strong>{confirmation.serviceName}</strong></p>}<p className="text-sm text-amber-700">This changes the selected endpoint and can disrupt users. No automatic retries. Unknown outcomes must be investigated using status checks.</p><div className="flex justify-end gap-2"><button className="secondary-button" onClick={() => setConfirmation(null)}>Cancel</button><button className="primary-button" disabled={!allowed(confirmation)} onClick={() => void execute()}>Confirm action</button></div></div></Modal>}
  </div>
}

function ApproveSoftwareTicket({ token, assetPath, application, disabled, onApproved, compact = false }: { token: string; assetPath: string; application: CatalogApplication; disabled: boolean; onApproved: () => void; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const [ticketNumber, setTicketNumber] = useState('')
  const [action, setAction] = useState<'install' | 'remove'>('install')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const lock = useRef(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    const request = new AbortController()
    controller.current = request
    const unsubscribe = subscribeAuth(() => { if (getToken() !== token) request.abort() })
    return () => { request.abort(); unsubscribe() }
  }, [token])
  async function approve() {
    const signal = controller.current?.signal
    if (disabled || !confirmed || !ticketNumber.trim() || lock.current || uncertain || !signal || signal.aborted || getToken() !== token) return
    lock.current = true; setBusy(true); setError('')
    try {
      await endpointRequest(token, `${assetPath}/software-approvals`, signal, { applicationId: application.id, ticketNumber: ticketNumber.trim(), action, confirmed: true })
      setOpen(false); setConfirmed(false); setTicketNumber(''); onApproved()
    } catch (failure) {
      if (!signal.aborted) { setError(`${message(failure)} Close and refresh approvals before trying again.`); setUncertain(true) }
    } finally {
      lock.current = false
      if (!signal.aborted) setBusy(false)
    }
  }
  return <><button className={compact ? 'icon-button h-8 w-8' : 'secondary-button'} aria-label={compact ? `Approve ticket for ${application.name}` : undefined} title="Approve ticket" disabled={disabled || busy || uncertain} onClick={() => { setConfirmed(false); setOpen(true) }}>{compact ? <ClipboardCheck size={16} /> : 'Approve ticket'}</button>{open && <Modal title="Approve software ticket" onClose={() => { if (!busy) setOpen(false) }}><div className="space-y-4 p-5"><p>{application.name} · {application.packageName}</p><label className="block text-sm font-bold">Existing ticket number<input className="field mt-2" value={ticketNumber} maxLength={100} disabled={busy} onChange={event => setTicketNumber(event.target.value)} /></label><label className="block text-sm font-bold">Approved action<select className="field mt-2" value={action} disabled={busy} onChange={event => setAction(event.target.value as typeof action)}><option value="install">Install</option><option value="remove">Remove</option></select></label><label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />I approve this ticket for one selected application action on this system.</label>{error && <p role="alert">{error}</p>}<div className="flex justify-end gap-2"><button className="secondary-button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button><button className="primary-button" disabled={disabled || busy || uncertain || !confirmed || !ticketNumber.trim()} onClick={() => void approve()}>Confirm ticket approval</button></div></div></Modal>}</>
}

export function AddApprovedApplication({ token, device, os, canCreate, catalogRevision, catalogReady, refreshCatalog, onCreated }: {
  token: string; device: Pick<DeviceInventory, 'entityId'> & Partial<Pick<DeviceInventory, 'id' | 'assetTag' | 'hostname'>>; os: string; canCreate: boolean; catalogRevision: number; catalogReady: boolean
  refreshCatalog: () => void; onCreated: () => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [packageName, setPackageName] = useState('')
  const [description, setDescription] = useState('')
  const [approved, setApproved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [uncertainRevision, setUncertainRevision] = useState<number | null>(null)
  const lock = useRef(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    const request = new AbortController()
    controller.current = request
    const unsubscribe = subscribeAuth(() => { if (getToken() !== token) request.abort() })
    return () => { request.abort(); unsubscribe() }
  }, [token])
  const needsRefresh = uncertainRevision !== null && (!catalogReady || catalogRevision <= uncertainRevision)
  const close = () => { if (!lock.current) setOpen(false) }

  async function create() {
    const signal = controller.current?.signal
    if (!signal || signal.aborted || getToken() !== token || !canCreate || lock.current || needsRefresh) return
    const validation = catalogInputError(name, packageName, description)
    if (validation || !approved) { setError(validation || 'Explicit package approval is required.'); return }
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const created = await endpointRequest<CatalogApplication>(token, '/software/catalog', signal, {
        entityId: device.entityId, name: name.trim(), os, packageName, active: true, ...(description ? { description } : {}),
      })
      if (!created?.id || created.entityId !== device.entityId || created.os !== os || created.packageName !== packageName || created.active !== true) throw new Error('Unexpected catalog response.')
      setOpen(false); setName(''); setPackageName(''); setDescription(''); setApproved(false); setUncertainRevision(null)
      setNotice('Approved application added. Catalog refreshed from page 1; the new entry may be on a later page. Select an approved package to review an endpoint action. Nothing was installed.')
      onCreated()
    } catch (failure) {
      if (signal.aborted || getToken() !== token) return
      const definitive = failure instanceof EndpointApiError && [400, 401, 403, 404, 409, 422].includes(failure.status)
      if (!definitive) setUncertainRevision(catalogRevision)
      setError(`${message(failure)} No automatic retry was made.${definitive ? '' : ' Outcome uncertain. Refresh catalog and check for the entry (including later pages) before retrying.'}`)
    } finally {
      if (!signal.aborted && getToken() === token) { lock.current = false; setBusy(false) }
    }
  }

  return <>
    {canCreate && <button className="secondary-button" onClick={() => setOpen(true)}>Add approved application</button>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {open && canCreate && <Modal title="Add approved application" size="max-w-lg" onClose={close}>
      <form className="space-y-4 p-5" noValidate onSubmit={event => { event.preventDefault(); void create() }}>
        <p className="break-all text-xs">{device.id && <>Selected asset: {device.assetTag || device.hostname || device.id} · {device.id}<br /></>}Entity: {device.entityId} · OS: {os}{device.id ? ' (locked to this asset)' : ''}</p>
        <p className="rounded-md border border-amber-300 p-3 text-sm">Approval adds this exact package to the active catalog for the entire entity and OS, not just this asset. Authorized operators can then install or remove it. This does not install software. Verify the package identifier from a trusted package source; inventory names are not approval.</p>
        <label className="block text-sm font-bold">Application name<input className="field mt-1" value={name} maxLength={150} required disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <label className="block text-sm font-bold">Package identifier<input className="field mt-1" value={packageName} maxLength={200} required disabled={busy} onChange={event => setPackageName(event.target.value)} /></label>
        <label className="block text-sm font-bold">Description (optional)<textarea className="field mt-1" rows={2} value={description} maxLength={4000} disabled={busy} onChange={event => setDescription(event.target.value)} /></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={approved} disabled={busy} onChange={event => setApproved(event.target.checked)} />I approve this exact package for this entity and OS.</label>
        {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
        {uncertainRevision !== null && <button type="button" className="secondary-button" disabled={busy} onClick={refreshCatalog}>Refresh catalog before retry</button>}
        <div className="flex justify-end gap-2"><button type="button" className="secondary-button" disabled={busy} onClick={close}>Cancel</button><button type="submit" className="primary-button" disabled={busy || needsRefresh}>{busy ? 'Adding…' : 'Approve and add'}</button></div>
      </form>
    </Modal>}
  </>
}