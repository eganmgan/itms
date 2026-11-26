import { useState } from 'react'
import { Search, RefreshCw } from 'lucide-react'
import { useManualResource, type SessionProps } from './api'

type Accessory = { id: string; source: string; name: string; category: string; assetTag: string; serialNumber: string; entity: string; location: string; assignee: string; status: string; notes: string }
type Page = { items: Accessory[]; page: number; hasMore: boolean }

export function AccessoriesSection(props: SessionProps) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const result = useManualResource<Page>(props, `/admin/accessories?page=${page}&search=${encodeURIComponent(query)}`, revision)
  return <section aria-label="Accessories and equipment" className="min-w-0 space-y-4">
    <h2 className="text-xl font-bold">Accessories, equipment &amp; stock</h2>
    <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setPage(1); setRevision(value => value + 1) }}>
      <label className="min-w-0 flex-1 text-sm">Search accessories<input className="field mt-1 w-full" maxLength={150} value={search} onChange={event => setSearch(event.target.value)} /></label>
      <button className="secondary-button" type="submit"><Search size={16} />Search</button><button className="secondary-button" type="button" disabled={result.loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} />Refresh</button>
    </form>
    {result.loading && <p role="status">Loading accessories...</p>}
    {result.error && <p role="alert">{result.error}</p>}
    {result.data && <><div className="max-w-full overflow-x-auto"><table className="data-table w-full"><thead><tr>{['Item', 'Category / source', 'Asset tag / serial', 'Entity / location', 'Assigned to', 'Status', 'Notes'].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{result.data.items.length ? result.data.items.map(item => <tr key={`${item.source}:${item.id}`}><td className="min-w-40 max-w-80 break-words">{item.name}</td><td>{item.category}<small className="block">{item.source === 'stock' ? 'Manual stock' : 'Asset register'}</small></td><td>{item.assetTag || 'Not recorded'}<small className="block">{item.serialNumber || 'Serial not recorded'}</small></td><td className="min-w-40">{item.entity || 'Not recorded'}<small className="block">{item.location || 'Location not assigned'}</small></td><td>{item.assignee || 'Unassigned'}</td><td>{item.status}</td><td className="max-w-96 break-words">{item.notes ? <details><summary className="cursor-pointer">Recorded notes</summary><p className="whitespace-pre-wrap">{item.notes}</p></details> : 'Not recorded'}</td></tr>) : <tr><td colSpan={7}>No matching accessories or stock.</td></tr>}</tbody></table></div><div className="flex items-center gap-3"><button className="secondary-button" disabled={page === 1} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page {page}</span><button className="secondary-button" disabled={!result.data.hasMore} onClick={() => setPage(value => value + 1)}>Next</button></div></>}
  </section>
}