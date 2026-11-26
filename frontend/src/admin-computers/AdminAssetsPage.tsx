import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { getToken, subscribeAuth, useAuthToken } from '../lib/auth'
import { accessFailure, adminRequest, useAdminResource } from './api'
import type { Computer, ComputerList, Option, Options } from './api'
import { buildPayload, changeEntity, fields, sections, toDraft, validateOptions, warrantyExpiry } from './model'
import { SupplierDetails } from '../admin-suppliers/AdminSuppliersPage'
import type { Draft } from './model'

const inputClass = 'w-full rounded-xl border bg-white px-3 py-2 text-sm dark:bg-slate-900'
type Props = { token: string; onDenied: () => void }

function Failure({ error, retry }: { error: Error; retry: () => void }) {
  return <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"><p>{error.message}</p><button type="button" className="secondary-button mt-3" onClick={retry}>Retry</button></div>
}

export function AdminAssetsPage(props: Props) {
  const accountToken = useAuthToken()
  // Keep drafts and saved detail responses isolated even outside the keyed App shell.
  if (!props.token || props.token !== accountToken) return <p role="alert">Account changed. Computer data has been cleared.</p>
  return <AdminAssetsSession key={props.token} {...props} />
}

function AdminAssetsSession({ token, onDenied }: Props) {
  const [mode, setMode] = useState<'list' | 'create' | string>('list')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [entityId, setEntity] = useState('')
  const [search, setSearch] = useState('')
  const [revision, setRevision] = useState(0)
  const options = useAdminResource<Options>(token, '/admin/assets/options', revision)
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
  if (entityId) query.set('entityId', entityId)
  const list = useAdminResource<ComputerList>(token, mode === 'list' ? `/admin/assets?${query}` : null, revision)
  const denied = accessFailure(options.error) || accessFailure(list.error)
  useEffect(() => { if (denied) onDenied() }, [denied, onDenied])
  useEffect(() => {
    if (list.data && page > Math.max(1, Math.ceil(list.data.total / pageSize))) setPage(Math.max(1, Math.ceil(list.data.total / pageSize)))
  }, [list.data, page, pageSize])
  if (denied) return <p role="alert">Access denied. Computer data has been cleared.</p>
  const refresh = () => setRevision(value => value + 1)
  const items = list.data?.items.filter(item => [item.name, item.assetTag, item.serialNumber, item.hostname, item.category, item.manufacturer, item.osName].some(value => value?.toLowerCase().includes(search.trim().toLowerCase()))) ?? []
  return <section className="mx-auto max-w-7xl space-y-5" aria-label="Computer administration">
    <div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-widest text-brand-600">Administration · Canonical inventory</p><h1 className="mt-1 text-2xl font-bold">Manual computers</h1><p className="mt-2 text-sm text-slate-500">Manage computer identity, OS and purchase records. These are not stock items.</p></div>
      {mode === 'list' ? <button className="primary-button" disabled={!options.data} onClick={() => setMode('create')}>Create computer</button> : <button className="secondary-button" onClick={() => setMode('list')}>Back to computers</button>}
    </div>
    {options.error ? <Failure error={options.error} retry={refresh} /> : options.loading ? <p role="status">Loading computer options…</p> : null}
    {mode === 'create' && options.data && <ComputerForm token={token} entities={options.data.entities} onDenied={onDenied} onCancel={() => setMode('list')} onSaved={computer => { refresh(); setMode(computer.id) }} />}
    {mode !== 'list' && mode !== 'create' && options.data && <ComputerDetails key={mode} id={mode} token={token} entities={options.data.entities} onDenied={onDenied} onSaved={refresh} />}
    {mode === 'list' && <>
      <div className="card grid gap-4 p-4 sm:grid-cols-3">
        <label className="space-y-1 text-sm font-semibold">Search this page<input className={inputClass} type="search" value={search} placeholder="Name, asset number, serial…" onChange={event => setSearch(event.target.value)} /></label>
        <label className="space-y-1 text-sm font-semibold">Entity filter<select className={inputClass} value={entityId} disabled={!options.data} onChange={event => { setEntity(event.target.value); setPage(1) }}><option value="">All permitted entities</option>{options.data?.entities.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
        <label className="space-y-1 text-sm font-semibold">Rows per page<select className={inputClass} value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1) }}>{[25, 50, 100, 200].map(size => <option key={size}>{size}</option>)}</select></label>
      </div>
      <p className="text-xs text-slate-500">Search filters only the loaded page; the API does not provide server-side search.</p>
      {list.error ? <Failure error={list.error} retry={refresh} /> : list.loading ? <p role="status">Loading computers…</p> : list.data && <>
        <div className="card overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Canonical computers</caption><thead className="bg-slate-100 dark:bg-slate-800"><tr>{['Asset number', 'Name', 'Type', 'Status', 'Serial', 'Actions'].map(label => <th className="p-4" key={label} scope="col">{label}</th>)}</tr></thead><tbody>{items.map(computer => <tr key={computer.id} className="border-t"><td className="p-4 font-mono">{computer.assetTag}</td><td className="p-4 font-semibold">{computer.name}</td><td className="p-4">{computer.category}</td><td className="p-4">{computer.status}</td><td className="p-4">{computer.serialNumber || 'Not recorded'}</td><td className="p-4"><button className="secondary-button" aria-label={`Details for ${computer.assetTag}`} onClick={() => setMode(computer.id)}>Details</button></td></tr>)}</tbody></table>{!items.length && <p className="p-6 text-sm text-slate-500">{search ? 'No matches on this page.' : 'No computers found.'}</p>}</div>
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm" aria-live="polite">Page {list.data.page} of {Math.max(1, Math.ceil(list.data.total / list.data.pageSize))} · {list.data.total} computers{search ? ` · ${items.length} matches on this page` : ''}</p><div className="flex gap-2"><button className="secondary-button" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button><button className="secondary-button" disabled={page >= 1000000 || page * pageSize >= list.data.total} onClick={() => setPage(value => value + 1)}>Next</button></div></div>
      </>}
    </>}
  </section>
}

function ComputerDetails({ id, token, entities, onDenied, onSaved }: Props & { id: string; entities: Option[]; onSaved: () => void }) {
  const [revision, setRevision] = useState(0)
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState<Computer>()
  const detail = useAdminResource<Computer>(token, `/admin/assets/${encodeURIComponent(id)}`, revision)
  const computer = saved ?? detail.data
  const options = useAdminResource<Options>(token, computer ? `/admin/assets/options?entityId=${encodeURIComponent(computer.entityId)}` : null, revision)
  const denied = accessFailure(detail.error) || accessFailure(options.error)
  useEffect(() => { if (denied) onDenied() }, [denied, onDenied])
  if (denied) return <p role="alert">Access denied. Computer data has been cleared.</p>
  if (detail.error) return <Failure error={detail.error} retry={() => setRevision(value => value + 1)} />
  if (!computer) return <p role="status">Loading computer details…</p>
  if (editing) return <ComputerForm key={computer.id} token={token} original={computer} entities={entities} onDenied={onDenied} onCancel={() => setEditing(false)} onSaved={updated => { setSaved(updated); setEditing(false); onSaved() }} />
  return <div className="space-y-4">
    <div className="flex items-center justify-between"><h2 className="text-xl font-bold">{computer.name}</h2><button className="primary-button" onClick={() => setEditing(true)}>Edit computer</button></div>
    {options.error && <Failure error={options.error} retry={() => setRevision(value => value + 1)} />}
    {sections.map(section => <section className="card p-5" key={section}><h3 className="mb-4 font-bold">{section}</h3><dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{fields.filter(field => field.section === section).map(field => {
      const value = computer[field.key]
      const choices = field.options === 'entities' ? entities : field.options ? options.data?.[field.options] : undefined
      const display = value === null || value === undefined || value === '' ? 'Not recorded' : choices?.find(option => option.id === value)?.name ?? String(value)
      return <div key={field.key}><dt className="text-xs font-semibold text-slate-500">{field.label}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm">{display}</dd></div>
    })}{section === 'Warranty Information' && <div><dt className="text-xs font-semibold text-slate-500">Warranty expiry</dt><dd className="mt-1 text-sm">{computer.warrantyUntil ?? 'Not recorded'}</dd></div>}</dl>{section === 'Financial & Administrative Information' && <SupplierDetails key={computer.supplierId} id={computer.supplierId} token={token} onDenied={onDenied} />}</section>)}
  </div>
}

function ComputerForm({ token, original, entities, onDenied, onSaved, onCancel }: Props & { original?: Computer; entities: Option[]; onSaved: (computer: Computer) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(original))
  const [error, setError] = useState('')
  const [writeFailed, setWriteFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [revision, setRevision] = useState(0)
  const lock = useRef(false)
  const lifecycle = useRef<AbortController | null>(null)
  const options = useAdminResource<Options>(token, draft.entityId ? `/admin/assets/options?entityId=${encodeURIComponent(draft.entityId)}` : null, revision)
  const denied = accessFailure(options.error)
  useEffect(() => { if (denied) onDenied() }, [denied, onDenied])
  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    const unsubscribe = subscribeAuth(() => { if (getToken() !== token) controller.abort() })
    return () => { controller.abort(); unsubscribe() }
  }, [token])
  let expiry = original?.warrantyUntil ?? null
  const old = toDraft(original)
  if (!original || draft.warrantyStartDate !== old.warrantyStartDate || draft.warrantyDurationMonths !== old.warrantyDurationMonths) {
    try { expiry = warrantyExpiry(draft.warrantyStartDate, draft.warrantyDurationMonths) } catch { expiry = 'Invalid warranty inputs' }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    const controller = lifecycle.current
    if (lock.current || !controller || controller.signal.aborted || getToken() !== token) return
    setError(''); setWriteFailed(false)
    let writeAttempted = false
    try {
      for (const field of fields.filter(field => field.kind === 'date')) {
        const input = (event.currentTarget as HTMLFormElement).elements.namedItem(`computer-${field.key}`) as HTMLInputElement | null
        if (input?.validity.badInput) throw new Error(`${field.label} must be YYYY-MM-DD, years 0001–9999.`)
      }
      const payload = buildPayload(draft, original)
      if (!options.data) throw new Error('Wait for entity options to load before saving.')
      validateOptions(payload, options.data)
      lock.current = true; setSaving(true)
      writeAttempted = true
      const result = await adminRequest<Computer>(token, `/admin/assets${original ? `/${encodeURIComponent(original.id)}` : ''}`, controller.signal, original ? 'PATCH' : 'POST', payload)
      if (!controller.signal.aborted && getToken() === token) onSaved(result)
    } catch (failure) {
      if (!controller.signal.aborted && getToken() === token) {
        if (accessFailure(failure)) onDenied()
        else { setError(failure instanceof Error ? failure.message : 'Unable to save computer.'); setWriteFailed(writeAttempted) }
      }
    } finally {
      if (!controller.signal.aborted && getToken() === token) { lock.current = false; setSaving(false) }
    }
  }
  if (denied) return <p role="alert">Access denied. Computer data has been cleared.</p>
  return <form className="space-y-5" onSubmit={event => void submit(event)} noValidate aria-label={original ? 'Edit computer' : 'Create computer'}>
    <h2 className="text-xl font-bold">{original ? 'Edit computer' : 'Create computer'}</h2><p className="text-sm text-slate-500">Required fields are marked *. Blank optional fields clear recorded values. Group in charge uses a department.</p>
    {error && <p role="alert" className="rounded-xl bg-rose-50 p-4 text-sm text-rose-800">{error}{writeFailed && ' No automatic write retry is performed; after a connection failure, check the list before retrying a create.'}</p>}
    {options.error && <Failure error={options.error} retry={() => setRevision(value => value + 1)} />}
    {options.loading && <p role="status">Loading entity options…</p>}
    <fieldset disabled={saving} className="space-y-5">
      {sections.map(section => <section className="card p-5" key={section}><h3 className="mb-4 font-bold">{section}</h3><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{fields.filter(field => field.section === section).map(field => {
        const value = draft[field.key]
        const choices = field.options === 'entities' ? entities : field.options ? options.data?.[field.options] ?? [] : []
        const update = (value: string) => setDraft(current => field.key === 'entityId' ? changeEntity(current, value) : { ...current, [field.key]: value })
        const id = `computer-${field.key}`
        return <div className={field.kind === 'multiline' ? 'sm:col-span-2' : ''} key={field.key}><label htmlFor={id} className="mb-1 block text-sm font-semibold">{field.label}{field.required ? ' *' : ''}</label>
          {field.options ? <select id={id} className={inputClass} required={field.required} value={value} onChange={event => update(event.target.value)} disabled={field.options !== 'entities' && (!draft.entityId || !options.data)}><option value="">{field.required ? 'Select entity' : 'Not recorded'}</option>{value && !choices.some(option => option.id === value) && <option value={value}>Current ID (unavailable): {value}</option>}{choices.map(option => <option value={option.id} key={option.id}>{option.name}</option>)}</select>
            : field.kind === 'multiline' ? <textarea id={id} className={inputClass} rows={3} maxLength={field.max} value={value} onChange={event => update(event.target.value)} />
                : <input id={id} className={inputClass} type={field.kind === 'date' ? 'date' : 'text'} min={field.kind === 'date' ? '0001-01-01' : undefined} max={field.kind === 'date' ? '9999-12-31' : undefined} aria-describedby={field.kind === 'date' ? `${id}-hint` : undefined} inputMode={field.kind === 'money' ? 'decimal' : field.kind === 'months' ? 'numeric' : undefined} required={field.required} maxLength={field.max} value={value} onChange={event => update(event.target.value)} />}
              {field.kind === 'date' && <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">Choose a date. Saved as YYYY-MM-DD (years 0001–9999).</p>}
          {field.kind === 'money' && <p className="mt-1 text-xs text-slate-500">Exact decimal amount, e.g. 1200.50. No currency field is provided by the API.</p>}
        </div>
      })}{section === 'Warranty Information' && <div><p className="text-sm font-semibold">Warranty expiry (calculated)</p><output className="mt-2 block text-sm" aria-label="Warranty expiry">{expiry ?? 'Not recorded'}</output></div>}</div>{section === 'Financial & Administrative Information' && <SupplierDetails key={draft.supplierId} id={draft.supplierId} token={token} onDenied={onDenied} />}</section>)}
      <div className="flex gap-3"><button type="submit" className="primary-button" disabled={saving || options.loading || !!options.error}>{saving ? 'Saving…' : original ? 'Save changes' : 'Save computer'}</button><button type="button" className="secondary-button" onClick={onCancel}>Cancel</button></div>
    </fieldset>
  </form>
}