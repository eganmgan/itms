import { useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useAdminResource, type Options } from '../admin-computers/api'
import { AddApprovedApplication } from '../pages/AppsServicesPanel'
import { useEndpointResource, type CatalogPage, type SoftwarePermissions } from '../lib/appsServices'

export function ApplicationsSection({ token }: { token: string }) {
  const options = useAdminResource<Options>(token, '/admin/assets/options')
  const permissions = useEndpointResource<SoftwarePermissions>(token, '/software/permissions')
  const [entityId, setEntityId] = useState('')
  const [os, setOS] = useState('linux')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const entity = options.data?.entities.find(item => item.id === entityId)
  const catalog = useEndpointResource<CatalogPage>(token, entity ? `/software/catalog?entityId=${encodeURIComponent(entityId)}&os=${os}&page=${page}` : null, revision)
  const refresh = () => { setPage(1); setRevision(value => value + 1) }
  return <section aria-label="Application catalog" className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-bold">Applications</h2><a className="secondary-button" href="/patch/apps">Apps &amp; Services</a></div>
    {(options.error || permissions.error || catalog.error) && <p role="alert">{options.error?.message || permissions.error || catalog.error}</p>}
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm font-bold">Entity<select className="field mt-2" disabled={options.loading || !options.data} value={entityId} onChange={event => { setEntityId(event.target.value); setPage(1) }}><option value="">Select entity</option>{options.data?.entities.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="text-sm font-bold">Operating system<select className="field mt-2" value={os} onChange={event => { setOS(event.target.value); setPage(1) }}><option value="linux">Linux</option><option value="windows">Windows</option><option value="macos">macOS</option></select></label>
    </div>
    {entity && <><div className="flex flex-wrap items-center gap-3"><AddApprovedApplication key={`${entityId}:${os}`} token={token} device={{ entityId }} os={os} canCreate={permissions.data?.canManageCatalog === true && catalog.data?.capabilities.canManageCatalog === true} catalogRevision={revision} catalogReady={!!catalog.data && !catalog.loading && !catalog.error} refreshCatalog={refresh} onCreated={refresh} /><button className="secondary-button" aria-label="Refresh applications" title="Refresh applications" onClick={refresh} disabled={catalog.loading}><RefreshCw size={16} /></button></div>
      {catalog.loading && <p role="status">Loading applications...</p>}
      {catalog.data && <><div className="overflow-x-auto"><table className="data-table"><thead><tr><th>Name</th><th>Package</th><th>OS</th><th>Status</th></tr></thead><tbody>{catalog.data.items.map(item => <tr key={item.id}><td>{item.name}</td><td>{item.packageName}</td><td>{item.os}</td><td>{item.active ? 'Active' : 'Inactive'}</td></tr>)}</tbody></table></div>{!catalog.data.items.length && <p>No applications found.</p>}
        <div className="flex items-center gap-3"><button className="secondary-button" disabled={page === 1} onClick={() => setPage(value => value - 1)}>Previous applications</button><span>Page {page}</span><button className="secondary-button" disabled={!catalog.data.hasMore} onClick={() => setPage(value => value + 1)}>Next applications</button></div></>}
    </>}
  </section>
}