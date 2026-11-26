import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Building2, CheckCircle2, Download, Eye, Flag, FolderTree, Laptop, Pencil, Plus, RefreshCw, Search, WifiOff, X } from 'lucide-react'
import { AddDeviceModal, type ManualDeviceRecord } from '../components/AddDeviceModal'
import { InstallAgentModal } from '../components/InstallAgentModal'
import { Badge } from '../components/ui'
import { GatepassRecordPicker } from './GatepassRecordPicker'
import { subscribeRecordChanges } from '../lib/recordChanges'

type Category = 'all' | 'new' | 'ungrouped' | 'flagged'

interface DirectoryConnectivity {
  status: 'online' | 'offline' | 'unknown' | 'unassigned'
  connectivitySource?: string
  connectivityCheckedAt?: string | null
  lastHeartbeatAt?: string | null
}

interface DirectoryAsset extends DirectoryConnectivity {
  id: string
  name: string
  hostname?: string
  assetTag?: string
  category: string
  lastSeenAt?: string | null
}

export interface DirectoryUser extends DirectoryConnectivity {
  id: string
  fullName: string
  email: string
  employeeCode: string
  departmentId?: string
  departmentName: string
  branchId?: string
  branchName: string
  assetCount: number
  newAssetCount: number
  ungroupedAssetCount: number
  flaggedAssetCount: number
  primaryAssetId?: string
  assets?: DirectoryAsset[]
}

export interface DirectoryGroup {
  id: string
  name: string
  deviceCount: number
}

interface DirectoryResponse {
  summary: Record<Category, number>
  capabilities: { addDevice: boolean; installAgent: boolean; manageStock?: boolean }
  departments: DirectoryGroup[]
  branches: DirectoryGroup[]
  users: DirectoryUser[]
}

const categoryDefinitions = [
  { id: 'all' as const, icon: Laptop, label: 'All Devices' },
  { id: 'new' as const, icon: Plus, label: 'New Devices' },
  { id: 'ungrouped' as const, icon: FolderTree, label: 'Ungrouped Devices' },
  { id: 'flagged' as const, icon: Flag, label: 'Flagged Devices' },
]

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()
}

function errorMessage(status: number) {
  if (status === 401) return 'Your session has expired. Sign in to view your devices.'
  if (status === 403) return 'Your account does not have access to the device directory.'
  return 'The device directory is unavailable. Try again in a moment.'
}

function unknownConnectivity<T extends DirectoryConnectivity>(item: T): T {
  return { ...item, status: item.status === 'unassigned' ? 'unassigned' : 'unknown', connectivitySource: 'directory_unavailable', connectivityCheckedAt: null }
}

type ConnectivityResponse = { users: (DirectoryConnectivity & { id: string; assets: (DirectoryConnectivity & { id: string })[] })[] }

function mergeConnectivity(directory: DirectoryResponse, response: ConnectivityResponse): DirectoryResponse {
  const users = new Map(response.users.map(user => [user.id, new Map(user.assets.map(asset => [asset.id, asset]))]))
  return { ...directory, users: directory.users.map(user => {
    const updates = users.get(user.id)
    const assets = (user.assets ?? []).map(asset => {
      const update = updates?.get(asset.id)
      if (!update || !['online', 'offline', 'unknown'].includes(update.status)) return unknownConnectivity(asset)
      return { ...asset, status: update.status, connectivitySource: update.connectivitySource, connectivityCheckedAt: update.connectivityCheckedAt, lastHeartbeatAt: update.lastHeartbeatAt }
    })
    // Aggregate only assets present in this inventory generation. A response
    // cannot inject new assets, owners or capabilities into the directory.
    const best = assets.find(asset => asset.status === 'online') ?? assets.find(asset => asset.status === 'unknown') ?? assets[0]
    return { ...user, assets, status: best?.status ?? 'unassigned', connectivitySource: best?.connectivitySource ?? 'unmanaged', connectivityCheckedAt: best?.connectivityCheckedAt ?? null, lastHeartbeatAt: best?.lastHeartbeatAt }
  }) }
}

function connectivityDescription(item: DirectoryConnectivity) {
  if (item.connectivitySource === 'agent_heartbeat') return `Agent heartbeat: ${item.lastHeartbeatAt || 'Not received'}. Checked: ${item.connectivityCheckedAt || 'Not checked'}`
  const source = item.connectivitySource || 'Not recorded'
  return `Connectivity source: ${source}. Checked: ${item.connectivityCheckedAt || 'Not checked'}`
}

export function DevicesPage({ onOpenDevice, employee = false }: { onOpenDevice: (user: DirectoryUser) => void; employee?: boolean }) {
  const [directory, setDirectory] = useState<DirectoryResponse | null>(null)
  const [stockItems, setStockItems] = useState<ManualDeviceRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [checking, setChecking] = useState(false)
  const [connectivityError, setConnectivityError] = useState('')
  const [stockLoading, setStockLoading] = useState(false)
  const [stockError, setStockError] = useState('')
  const [error, setError] = useState('')
  const [signInRequired, setSignInRequired] = useState(() => !localStorage.getItem('itms_token'))
  const loadDirectory = useRef(() => {})
  const loadStock = useRef(() => {})
  const [search, setSearch] = useState('')
  const [department, setDepartment] = useState('all')
  const [branch, setBranch] = useState('all')
  const [category, setCategory] = useState<Category>('all')
  const [sidebarPanel, setSidebarPanel] = useState<'departments' | 'branches'>('departments')
  const [installOpen, setInstallOpen] = useState(false)
  const [deviceModal, setDeviceModal] = useState<{ mode: 'add' | 'edit' | 'details'; device?: ManualDeviceRecord } | null>(null)

  useEffect(() => {
    // All requests belong to this effect/account generation, including JSON parsing.
    let active = true
    let generation = 0
    let token: string | null = null
    let directoryController: AbortController | undefined
    let connectivityController: AbortController | undefined
    let stockController: AbortController | undefined
    let directoryPending = false
    let connectivityPending = false
    let inventoryReady = false
    let stockPending = false
    let stockAllowed = false
    let stockAttempted = false
    let blocked = false
    const cancelRequests = () => {
      ++generation
      directoryController?.abort()
      connectivityController?.abort()
      stockController?.abort()
      directoryPending = false
      connectivityPending = false
      inventoryReady = false
      stockPending = false
    }
    const denyDirectory = (status: number) => {
      cancelRequests()
      blocked = true
      stockAllowed = false
      stockAttempted = false
      setDirectory(null); setStockItems([]); setStockError('')
      setDeviceModal(null); setInstallOpen(false)
      setLoading(false); setRefreshing(false); setStockLoading(false)
      setChecking(false); setConnectivityError('')
      setSignInRequired(status === 401)
      setError(errorMessage(status))
    }
    async function refreshStock() {
      if (!active || !token || blocked || !stockAllowed || stockPending || token !== localStorage.getItem('itms_token')) return
      const accountToken = token
      const requestGeneration = generation
      const controller = new AbortController()
      stockController = controller
      const isCurrent = () => active && generation === requestGeneration && !controller.signal.aborted && accountToken === localStorage.getItem('itms_token')
      stockPending = true
      stockAttempted = true
      setStockLoading(true); setStockError('')
      try {
        const response = await fetch('/api/inventory?page=1&pageSize=100', { headers: { Authorization: `Bearer ${accountToken}` }, signal: controller.signal, cache: 'no-store' })
        if (!isCurrent()) return
        if (response.status === 401) { denyDirectory(401); return }
        if (!response.ok) throw new Error('Manual stock is unavailable. The device directory is still available.')
        const data = await response.json() as { items?: ManualDeviceRecord[] }
        if (isCurrent()) setStockItems(data.items ?? [])
      } catch {
        if (isCurrent()) {
          setStockItems([])
          setStockError('Manual stock is unavailable. The device directory is still available.')
        }
      } finally {
        if (isCurrent()) { stockPending = false; setStockLoading(false) }
      }
    }
    async function refreshConnectivity() {
      if (!active) return
      if (token !== localStorage.getItem('itms_token')) { reloadForAuth(); return }
      if (!token || blocked || directoryPending || connectivityPending || !inventoryReady) return
      const accountToken = token
      const requestGeneration = generation
      const controller = new AbortController()
      connectivityController = controller
      const isCurrent = () => active && generation === requestGeneration && !controller.signal.aborted && accountToken === localStorage.getItem('itms_token')
      connectivityPending = true
      setChecking(true)
      try {
        const response = await fetch('/api/devices/directory/connectivity', { headers: { Authorization: `Bearer ${accountToken}` }, signal: controller.signal, cache: 'no-store' })
        if (!isCurrent()) return
        if (response.status === 401 || response.status === 403) { denyDirectory(response.status); return }
        if (!response.ok) throw new Error('Connectivity unavailable')
        const data = await response.json() as ConnectivityResponse
        if (!isCurrent()) return
        // Validate before scheduling a React state updater, so malformed bodies
        // fail here rather than throwing during render and retaining online.
        if (!data || !Array.isArray(data.users) || data.users.some(user => !user || typeof user.id !== 'string' || !Array.isArray(user.assets) || user.assets.some(asset => !asset || typeof asset.id !== 'string' || !['online', 'offline', 'unknown'].includes(asset.status)))) throw new Error('Invalid connectivity response')
        setDirectory(current => current && mergeConnectivity(current, data))
        setConnectivityError('')
      } catch {
        if (!isCurrent()) return
        setConnectivityError('Live connectivity is unavailable. Inventory is still available.')
        setDirectory(current => current && ({ ...current, users: current.users.map(user => ({ ...unknownConnectivity(user), assets: user.assets?.map(unknownConnectivity) })) }))
      } finally {
        if (isCurrent()) { connectivityPending = false; setChecking(false) }
      }
    }
    async function refreshDirectory() {
      if (!active) return
      if (token !== localStorage.getItem('itms_token')) { reloadForAuth(); return }
      if (!token || blocked || directoryPending || connectivityPending) return
      const accountToken = token
      const requestGeneration = generation
      const controller = new AbortController()
      directoryController = controller
      const isCurrent = () => active && generation === requestGeneration && !controller.signal.aborted && accountToken === localStorage.getItem('itms_token')
      directoryPending = true
      let inventoryLoaded = false
      setRefreshing(true); setError('')
      try {
        const response = await fetch('/api/devices/directory?connectivity=deferred', { headers: { Authorization: `Bearer ${accountToken}` }, signal: controller.signal, cache: 'no-store' })
        if (!isCurrent()) return
        if (response.status === 401 || response.status === 403) { denyDirectory(response.status); return }
        if (!response.ok) throw new Error(errorMessage(response.status))
        const data = await response.json() as DirectoryResponse
        if (!isCurrent()) return
        setDirectory({ ...data, users: data.users.map(user => ({ ...unknownConnectivity(user), connectivitySource: 'deferred', assets: user.assets?.map(asset => ({ ...unknownConnectivity(asset), connectivitySource: 'deferred' })) })) })
        inventoryReady = true
        inventoryLoaded = true
        setConnectivityError('')
        setSignInRequired(false)
        stockAllowed = data.capabilities.manageStock === true
        if (!stockAllowed) {
          stockController?.abort(); stockPending = false; stockAttempted = false
          setStockItems([]); setStockError(''); setStockLoading(false); setDeviceModal(null)
        } else if (!stockAttempted) {
          // Stock and reachability never block rendering the directory.
          void refreshStock()
        }
        if (!data.capabilities.installAgent) setInstallOpen(false)
      } catch {
        if (!isCurrent()) return
        setError(errorMessage(500))
        // Retain rows/filters, but never keep a stale successful probe after failure.
        setDirectory(current => current && ({ ...current, users: current.users.map(user => ({ ...unknownConnectivity(user), assets: user.assets?.map(unknownConnectivity) })) }))
      } finally {
        if (isCurrent()) {
          directoryPending = false; setLoading(false); setRefreshing(false)
          if (inventoryLoaded) void refreshConnectivity()
        }
      }
    }
    function reloadForAuth() {
      cancelRequests()
      token = localStorage.getItem('itms_token')
      blocked = false; stockAllowed = false; stockAttempted = false
      setDirectory(null); setStockItems([]); setError(''); setStockError('')
      setSignInRequired(!token); setLoading(!!token); setRefreshing(false); setStockLoading(false)
      setChecking(false); setConnectivityError('')
      setSearch(''); setDepartment('all'); setBranch('all'); setCategory('all')
      setDeviceModal(null); setInstallOpen(false)
      void refreshDirectory()
    }
    loadDirectory.current = () => { blocked = false; void refreshDirectory() }
    loadStock.current = () => { void refreshStock() }
    reloadForAuth()
    const onStorage = (event: StorageEvent) => { if (event.key === 'itms_token' || event.key === null) reloadForAuth() }
    const unsubscribeRecordChanges = subscribeRecordChanges(() => {
      if (token) loadDirectory.current()
    }, false)
    window.addEventListener('itms-auth-changed', reloadForAuth)
    window.addEventListener('storage', onStorage)
    return () => {
      active = false
      cancelRequests()
      loadDirectory.current = () => {}
      loadStock.current = () => {}
      unsubscribeRecordChanges()
      window.removeEventListener('itms-auth-changed', reloadForAuth)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (directory?.users ?? []).filter((user) => {
      const matchesSearch = !needle || [user.fullName, user.email, user.employeeCode].some((value) => value.toLowerCase().includes(needle))
      const matchesDepartment = department === 'all' || user.departmentId === department
      const matchesBranch = branch === 'all' || user.branchId === branch
      const matchesCategory = category === 'all' || (category === 'new' && user.newAssetCount > 0) || (category === 'ungrouped' && user.ungroupedAssetCount > 0) || (category === 'flagged' && user.flaggedAssetCount > 0)
      return matchesSearch && matchesDepartment && matchesBranch && matchesCategory
    })
  }, [branch, category, department, directory, search])

  if (employee && directory) {
    const employeeUser = directory.users[0] ?? null
    const employeeAssets = employeeUser?.assets ?? []
    return <div className="page-enter mx-auto max-w-[1200px] px-4 py-6">
      <div className="card mb-4 p-5">
        <p className="text-[10px] font-black uppercase tracking-widest text-brand-600">Employee access</p>
        <h2 className="mt-2 text-2xl font-black">{employeeUser?.email ?? 'My assets'}</h2>
        <p className="mt-2 text-sm text-slate-500">{employeeAssets.length} assets assigned to this account</p>
      </div>
      <div className="card p-4">
        <h3 className="mb-4 text-xl font-black">My assets</h3>
        <div className="grid gap-3 md:grid-cols-2">
          {employeeAssets.length === 0 ? <p className="text-sm text-slate-500">No assets assigned to this account.</p> : employeeAssets.map((asset) => (
            <button key={asset.id} type="button" aria-label={`View ${asset.name}`} className="rounded-xl border border-slate-200 p-4 text-left transition hover:border-brand-500 hover:bg-brand-50 dark:border-slate-700 dark:hover:bg-slate-800" onClick={() => onOpenDevice({ ...employeeUser!, primaryAssetId: asset.id, assets: employeeUser?.assets ?? [] })}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.15em] text-slate-400">Asset</p>
                  <p className="mt-2 text-lg font-black text-slate-800 dark:text-slate-100">{asset.name}</p>
                </div>
                <span className="rounded-full border border-brand-200 bg-brand-50 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-brand-700">{asset.status}</span>
              </div>
              <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
                <span>{asset.category}</span>
                <span className="font-bold text-brand-600">View {asset.name}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  }

  return <div className="page-enter mx-auto max-w-[1600px]">
    <div className="grid gap-5 xl:grid-cols-[256px_1fr]">
      <aside className="card self-start overflow-hidden xl:sticky xl:top-24">
        <div className="border-b p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Device Management</p>
          <div className="mt-3 grid grid-cols-2 rounded-xl bg-slate-100 p-1 dark:bg-slate-950">
            <button onClick={() => setSidebarPanel('departments')} className={`rounded-lg px-2 py-2 text-[11px] font-bold ${sidebarPanel === 'departments' ? 'bg-white text-brand-600 shadow-sm dark:bg-slate-800' : 'text-slate-500'}`}>Devices</button>
            <button onClick={() => setSidebarPanel('branches')} className={`rounded-lg px-2 py-2 text-[11px] font-bold ${sidebarPanel === 'branches' ? 'bg-white text-brand-600 shadow-sm dark:bg-slate-800' : 'text-slate-500'}`}>Branches</button>
          </div>
        </div>
        {sidebarPanel === 'departments' ? <div className="p-3">
          <p className="px-2 pb-2 text-[10px] font-black uppercase tracking-widest text-slate-400">Categories</p>
          {categoryDefinitions.map(({ id, icon: Icon, label }) => <button key={id} onClick={() => setCategory(id)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-xs font-bold ${category === id ? 'bg-blue-50 text-brand-600 dark:bg-blue-950/40' : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800'}`}><Icon size={16} /><span>{label}</span><span className="ml-auto rounded-md bg-white px-1.5 py-0.5 text-[10px] text-slate-400 shadow-sm dark:bg-slate-900">{directory?.summary[id] ?? '—'}</span></button>)}
          <p className="mt-5 px-2 pb-2 text-[10px] font-black uppercase tracking-widest text-slate-400">Departments</p>
          <button onClick={() => setDepartment('all')} className={`block w-full rounded-lg px-9 py-2 text-left text-[11px] font-semibold ${department === 'all' ? 'text-brand-600' : 'text-slate-500'}`}>All departments</button>
          {(directory?.departments ?? []).map((item) => <button key={item.id} onClick={() => setDepartment(item.id)} className={`flex w-full justify-between rounded-lg px-9 py-2 text-left text-[11px] font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 ${department === item.id ? 'text-brand-600' : 'text-slate-500'}`}><span>{item.name}</span><span>{item.deviceCount}</span></button>)}
        </div> : <div className="p-3">
          <p className="mb-2 px-2 text-[10px] font-black uppercase tracking-widest text-slate-400">Branch List</p>
          <button onClick={() => setBranch('all')} className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800 ${branch === 'all' ? 'text-brand-600' : ''}`}><Building2 size={16} /><strong className="text-xs">All branches</strong></button>
          {(directory?.branches ?? []).map((item) => <button key={item.id} onClick={() => setBranch(item.id)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800 ${branch === item.id ? 'bg-blue-50 text-brand-600 dark:bg-blue-950/40' : ''}`}><Building2 size={16} className="text-brand-600" /><span><strong className="block text-xs">{item.name}</strong><small className="text-[10px] text-slate-500">{item.deviceCount} assets</small></span></button>)}
        </div>}
      </aside>

      <section className="min-w-0 space-y-4">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div><p className="text-[10px] font-black uppercase tracking-widest text-brand-600">Asset Inventory</p><div className="mt-1 flex flex-wrap items-center gap-2"><h1 className="text-2xl font-black tracking-tight">Device Directory</h1></div>{directory && <p className="mt-1 text-xs text-slate-500">{directory.summary.all} managed endpoints across {directory.branches.length} branches</p>}</div>
          <div className="flex flex-wrap gap-2"><button className="secondary-button" onClick={() => loadDirectory.current()} disabled={refreshing || checking}><RefreshCw size={16} className={refreshing || checking ? 'animate-spin' : ''} />Refresh</button>{directory?.capabilities.addDevice && <button className="secondary-button" onClick={() => { window.history.pushState(null, '', '/admin/assets'); window.dispatchEvent(new PopStateEvent('popstate')) }}><Plus size={16} />Add Device</button>}{directory?.capabilities.installAgent && <button className="primary-button" onClick={() => setInstallOpen(true)} disabled={!directory.users.length}><Download size={16} />Install Agent</button>}</div>
        </div>

        {signInRequired ? <div role="alert" className="card flex min-h-72 flex-col items-center justify-center gap-3 p-8 text-center"><AlertCircle className="text-brand-600" size={28} /><h2 className="text-sm font-bold">Sign-in required</h2><p className="max-w-md text-sm">{error || 'Sign in to view your device inventory. Inventory is not loaded while signed out.'}</p><button className="primary-button" onClick={() => window.dispatchEvent(new Event('itms-open-sign-in'))}>Sign in</button></div> : <>
        <div className="card flex flex-col gap-3 p-3 md:flex-row">
          <label className="relative flex-1"><Search className="absolute left-3 top-2.5 text-slate-400" size={16} /><input className="field pl-10" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search user, email, or employee code" /></label>
          <div className="md:w-56"><GatepassRecordPicker label="Department filter" value={department === 'all' ? '' : department} choices={(directory?.departments ?? []).map(item => ({ id: item.id, label: item.name, display: item.name, keywords: item.name }))} onSelect={id => setDepartment(id || 'all')} placeholder="All departments" suggestionsOnTyping /></div>
          <div className="md:w-56"><GatepassRecordPicker label="Branch filter" value={branch === 'all' ? '' : branch} choices={(directory?.branches ?? []).map(item => ({ id: item.id, label: item.name, display: item.name, keywords: item.name }))} onSelect={id => setBranch(id || 'all')} placeholder="All branches" suggestionsOnTyping /></div>
        </div>

        {connectivityError && <p role="alert" className="card p-4 text-sm">{connectivityError}</p>}
        {checking && directory && <p role="status" className="text-xs text-slate-500">Checking live connectivity…</p>}
        {error && <div role="alert" className="card flex items-center gap-3 p-4"><AlertCircle className="text-rose-500" size={24} /><p className="text-sm">{error}{directory && ' Connectivity is unknown until a successful refresh.'}</p><button className="secondary-button" disabled={refreshing || checking} onClick={() => loadDirectory.current()}>Try Again</button></div>}
        {loading ? <div role="status" aria-label="Loading directory" className="card flex min-h-72 items-center justify-center"><RefreshCw className="animate-spin text-brand-600" size={24} /></div> : !directory ? null : rows.length === 0 ? <div className="card flex min-h-72 flex-col items-center justify-center gap-3 p-8 text-center"><Laptop className="text-slate-300" size={36} /><div><p className="text-sm font-bold">{directory.summary.all === 0 ? 'No devices enrolled yet' : 'No matching directory entries'}</p><p className="mt-1 text-xs text-slate-500">{directory.summary.all === 0 ? 'Generate an agent command for a user to enroll the first endpoint.' : 'Adjust the search or selected filters.'}</p></div>{(search || category !== 'all' || department !== 'all' || branch !== 'all') && <button className="secondary-button" onClick={() => { setSearch(''); setCategory('all'); setDepartment('all'); setBranch('all') }}><X size={15} />Clear Filters</button>}</div> : <div className="table-shell overflow-x-auto"><table className="data-table">
          <thead><tr>{['User / Email', 'Total Assets', 'Branch', 'Department', 'Status', 'Action'].map(heading => <th key={heading}>{heading}</th>)}</tr></thead>
          <tbody>{rows.map(user => <tr key={user.id}>
            <td><div className="flex items-center gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-[11px] font-black text-slate-600 dark:bg-slate-800 dark:text-slate-200">{initials(user.fullName)}</span><span><button disabled={!user.primaryAssetId} onClick={() => onOpenDevice(user)} className="block font-bold text-slate-800 enabled:hover:text-brand-600 disabled:cursor-default dark:text-slate-100">{user.fullName}</button><small className="text-[10px] text-slate-400">{user.email}</small></span></div></td>
            <td><span className="font-mono text-xs font-bold text-brand-600">{user.assetCount} {user.assetCount === 1 ? 'Asset' : 'Assets'}</span></td><td>{user.branchName}</td><td>{user.departmentName}</td>
            <td><span title={connectivityDescription(user)}><Badge tone={user.status === 'online' ? 'green' : user.status === 'offline' ? 'rose' : 'amber'}>{user.status === 'online' ? <CheckCircle2 size={12} /> : user.status === 'offline' ? <WifiOff size={12} /> : <AlertCircle size={12} />}{user.status[0].toUpperCase() + user.status.slice(1)}</Badge></span></td>
            <td>{user.primaryAssetId ? <button onClick={() => onOpenDevice(user)} className="text-[11px] font-bold text-brand-600">View Assets</button> : <span className="text-[11px] text-slate-400">Awaiting enrollment</span>}</td>
          </tr>)}</tbody>
        </table></div>}
        {directory?.capabilities.manageStock && <section className="space-y-3 pt-3" aria-labelledby="manual-stock-heading">
          <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-[10px] font-black uppercase tracking-widest text-brand-600">Inventory Stock</p><h2 id="manual-stock-heading" className="mt-1 text-lg font-black">Manual stock</h2><p className="mt-1 text-xs text-slate-500">Stock records are separate from manual computer administration.</p></div><div className="flex gap-2"><Badge tone="slate">{stockItems.length} items</Badge><button className="secondary-button" disabled={stockLoading} onClick={() => loadStock.current()}><RefreshCw size={16} />Refresh stock</button><button className="secondary-button" onClick={() => setDeviceModal({ mode: 'add' })}><Plus size={16} />Add stock</button></div></div>
          {stockError ? <p role="alert" className="card p-4 text-sm">{stockError}</p> : stockLoading && stockItems.length === 0 ? <p role="status" className="card p-4 text-sm">Loading manual stock…</p> : stockItems.length === 0 ? <div className="table-shell flex min-h-32 flex-col items-center justify-center gap-2 p-6 text-center"><Laptop size={28} className="text-slate-300" /><p className="text-xs font-bold text-slate-600 dark:text-slate-300">No manual stock added yet</p></div> : <div className="table-shell overflow-x-auto"><table className="data-table"><thead><tr>{['Item', 'Type', 'Asset Tag', 'Serial Number', 'Location', 'Status', 'Actions'].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{stockItems.map((item) => <tr key={item.id}><td><button className="text-left" onClick={() => setDeviceModal({ mode: 'details', device: item })}><strong className="block text-xs hover:text-brand-600">{item.name}</strong><small className="text-[10px] text-slate-500">{item.itemCode}</small></button></td><td>{item.category}</td><td>{item.assetTag}</td><td>{item.serialNumber || '-'}</td><td>{item.branchName || '-'}</td><td><Badge tone={item.status === 'inventory' ? 'green' : 'slate'}>{item.status === 'inventory' ? 'In stock' : item.status}</Badge></td><td><div className="flex gap-1"><button className="secondary-button h-8 px-2" aria-label={`View ${item.name}`} title="View details" onClick={() => setDeviceModal({ mode: 'details', device: item })}><Eye size={14} /></button><button className="secondary-button h-8 px-2" aria-label={`Edit ${item.name}`} title="Edit stock" onClick={() => setDeviceModal({ mode: 'edit', device: item })}><Pencil size={14} /></button></div></td></tr>)}</tbody></table></div>}
        </section>}
        </>}
      </section>
    </div>

    {deviceModal && directory?.capabilities.manageStock && <AddDeviceModal branches={directory.branches} groups={directory.departments} device={deviceModal.device} mode={deviceModal.mode} onClose={() => setDeviceModal(null)} onCreated={() => loadStock.current()} onEdit={deviceModal.device ? () => setDeviceModal({ mode: 'edit', device: deviceModal.device }) : undefined} />}
    {installOpen && directory?.capabilities.installAgent && <InstallAgentModal departments={directory.departments} users={directory.users} onClose={() => setInstallOpen(false)} />}
  </div>
}