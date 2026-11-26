import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { getToken, subscribeAuth, useAuthToken } from '../lib/auth'
import { accessFailure, adminRequest, useAdminResource } from './api'
import type { Options } from './api'
import { catalogPayload } from './catalog'
import type { CatalogConfig, CatalogProps, CatalogRecord } from './catalog'

type CatalogList = { items: CatalogRecord[]; page: number; hasMore: boolean; canWrite: boolean }
const inputClass = 'mt-1 w-full rounded-xl border bg-white px-3 py-2 text-sm dark:bg-slate-900'

export function AdminCatalogPage(props: CatalogProps & { config: CatalogConfig }) {
  const account = useAuthToken()
  if (!props.token || props.token !== account) return <p role="alert">Account changed. Administration data has been cleared.</p>
  return <CatalogSession key={`${props.token}:${props.config.path}`} {...props} />
}

function CatalogSession({ token, onDenied, config }: CatalogProps & { config: CatalogConfig }) {
  const [page, setPage] = useState(1)
  const [entity, setEntity] = useState('')
  const [mode, setMode] = useState('list')
  const [revision, setRevision] = useState(0)
  const [denied, setDenied] = useState(false)
  const options = useAdminResource<Options>(token, config.scoped && !denied ? '/admin/assets/options' : null, revision)
  const list = useAdminResource<CatalogList>(token, denied ? null : `${config.path}?page=${page}${entity ? `&entityId=${encodeURIComponent(entity)}` : ''}`, revision)
  const forbidden = denied || accessFailure(list.error) || accessFailure(options.error)
  useEffect(() => { if (forbidden) onDenied() }, [forbidden, onDenied])
  const revoke = () => { setDenied(true); onDenied() }
  if (forbidden) return <p role="alert">Access denied. Administration data has been cleared.</p>
  return <section className="mx-auto max-w-6xl space-y-5" aria-label={config.title}>
    <header className="card p-6"><p className="text-xs font-bold uppercase tracking-widest text-brand-600">Administration</p><h1 className="mt-2 text-2xl font-bold">{config.title}</h1><p className="mt-3 text-sm text-slate-500">{config.notice}</p></header>
    {(list.error || options.error) && <div role="alert" className="card p-4">{(list.error || options.error)?.message}<button className="secondary-button ml-3" onClick={() => setRevision(value => value + 1)}>Retry</button></div>}
    {config.scoped && <label className="block text-sm font-semibold">Entity filter<select className={inputClass} value={entity} disabled={mode !== 'list' || !options.data} onChange={event => { setEntity(event.target.value); setPage(1) }}><option value="">All permitted entities</option>{options.data?.entities.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>}
    {mode !== 'list' && <button className="secondary-button" onClick={() => setMode('list')}>Back to list</button>}
    {mode === 'create' && list.data?.canWrite && <CatalogEditor key="create" token={token} onDenied={revoke} config={config} options={options.data} onCancel={() => setMode('list')} onSaved={item => { setRevision(value => value + 1); setMode(item.id) }} />}
    {mode !== 'list' && mode !== 'create' && <CatalogDetail key={mode} id={mode} token={token} onDenied={revoke} config={config} canWrite={list.data?.canWrite === true} options={options.data} onSaved={() => setRevision(value => value + 1)} />}
    {mode === 'list' && <>
      {list.data?.canWrite && <button className="primary-button" onClick={() => setMode('create')}>Add {config.singular}</button>}
      {list.loading && <p role="status">Loading records…</p>}
      {list.data && <><div className="card overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">{config.title}</caption><thead><tr><th className="p-4">Name / application</th><th className="p-4">Details</th></tr></thead><tbody>{list.data.items.map(item => <tr key={item.id} className="border-t"><td className="p-4 font-semibold">{item.name}</td><td className="p-4"><button className="secondary-button" onClick={() => setMode(item.id)} aria-label={`Details for ${item.name}`}>Details</button></td></tr>)}</tbody></table>{!list.data.items.length && <p className="p-4">No records found.</p>}</div><div className="flex items-center gap-3"><button className="secondary-button" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page {list.data.page}</span><button className="secondary-button" disabled={!list.data.hasMore || page >= 1000000} onClick={() => setPage(value => value + 1)}>Next</button></div></>}
    </>}
  </section>
}

function CatalogDetail({ token, onDenied, config, id, canWrite, options, onSaved }: CatalogProps & { config: CatalogConfig; id: string; canWrite: boolean; options?: Options; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [revision, setRevision] = useState(0)
  const detail = useAdminResource<CatalogRecord>(token, `${config.path}/${encodeURIComponent(id)}`, revision)
  const denied = accessFailure(detail.error)
  useEffect(() => { if (denied) onDenied() }, [denied, onDenied])
  if (denied) return <p role="alert">Access denied.</p>
  if (detail.error) return <div role="alert">{detail.error.message}<button className="secondary-button ml-3" onClick={() => setRevision(value => value + 1)}>Retry detail</button></div>
  if (!detail.data) return <p role="status">Loading details…</p>
  if (editing && canWrite) return <CatalogEditor token={token} onDenied={onDenied} config={config} original={detail.data} options={options} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); setRevision(value => value + 1); onSaved() }} />
  return <section className="card space-y-5 p-6"><div className="flex items-center justify-between gap-4"><h2 className="text-xl font-bold">{detail.data.name}</h2>{canWrite && <button className="primary-button" onClick={() => setEditing(true)}>Edit {config.singular}</button>}</div><dl className="grid gap-5 sm:grid-cols-2">{config.fields.map(field => <div key={field.key} className={field.multiline ? 'sm:col-span-2' : ''}><dt className="text-xs font-semibold text-slate-500">{field.label}</dt><dd className={`mt-1 whitespace-pre-wrap break-words text-sm ${field.key === 'body' ? 'max-h-96 overflow-auto rounded-xl bg-slate-100 p-4 font-mono dark:bg-slate-950' : ''}`}>{(field.key === 'entityId' ? options?.entities.find(entity => entity.id === detail.data?.entityId)?.name : null) ?? detail.data?.[field.key] ?? 'Not recorded'}</dd></div>)}</dl></section>
}

function CatalogEditor({ token, onDenied, config, original, options, onCancel, onSaved }: CatalogProps & { config: CatalogConfig; original?: CatalogRecord; options?: Options; onCancel: () => void; onSaved: (item: CatalogRecord) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(() => Object.fromEntries(config.fields.map(field => [field.key, original?.[field.key] ?? (field.choices?.length === 1 ? field.choices[0] : '')])))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const lifecycle = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    const unsubscribe = subscribeAuth(() => { if (getToken() !== token) controller.abort() })
    return () => { controller.abort(); unsubscribe() }
  }, [token])
  async function submit(event: FormEvent) {
    event.preventDefault()
    const controller = lifecycle.current
    if (lock.current || !controller || controller.signal.aborted || getToken() !== token) return
    setError('')
    try {
      const payload = catalogPayload(config, draft, original)
      if (config.scoped && (!options || !options.entities.some(entity => entity.id === draft.entityId))) throw new Error('Select an available entity before saving.')
      lock.current = true; setSaving(true)
      const result = await adminRequest<CatalogRecord>(token, `${config.path}${original ? `/${encodeURIComponent(original.id)}` : ''}`, controller.signal, original ? 'PATCH' : 'POST', payload)
      if (!controller.signal.aborted && getToken() === token) onSaved(result)
    } catch (failure) {
      if (!controller.signal.aborted && getToken() === token) {
        if (accessFailure(failure)) onDenied()
        else setError(failure instanceof Error ? failure.message : 'Unable to save record.')
      }
    } finally {
      if (!controller.signal.aborted && getToken() === token) { lock.current = false; setSaving(false) }
    }
  }
  const title = `${original ? 'Edit' : 'Add'} ${config.singular}`
  return <form className="card space-y-5 p-6" aria-label={title} noValidate onSubmit={event => void submit(event)}><h2 className="text-xl font-bold">{title}</h2><p className="text-sm text-slate-500">Required fields are marked *. Do not store passwords, API keys, tokens or other secrets. Blank optional fields clear their values.</p>
    {error && <p role="alert">{error} Writes are not retried automatically; check the list after a connection failure before creating again.</p>}
    <fieldset disabled={saving} className="space-y-4">{config.fields.map(field => <label key={field.key} className="block text-sm font-semibold">{field.label}{field.required ? ' *' : ''}{field.key === 'entityId' ? <select className={inputClass} value={draft[field.key]} onChange={event => setDraft(current => ({ ...current, [field.key]: event.target.value }))} disabled={!options}><option value="">Select entity</option>{options?.entities.map(entity => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select> : field.choices ? <select className={inputClass} value={draft[field.key]} onChange={event => setDraft(current => ({ ...current, [field.key]: event.target.value }))}><option value="">Select {field.label.toLowerCase()}</option>{field.choices.map(value => <option key={value}>{value}</option>)}</select> : field.multiline ? <textarea className={`${inputClass} ${field.key === 'body' ? 'font-mono' : ''}`} rows={field.key === 'body' ? 12 : 4} maxLength={field.max} value={draft[field.key]} onChange={event => setDraft(current => ({ ...current, [field.key]: event.target.value }))} spellCheck={field.key !== 'body'} /> : <input className={inputClass} maxLength={field.max} value={draft[field.key]} onChange={event => setDraft(current => ({ ...current, [field.key]: event.target.value }))} />}</label>)}
      <div className="flex gap-3"><button className="primary-button" type="submit" disabled={saving || (config.scoped && !options)}>{saving ? 'Saving…' : 'Save record'}</button><button type="button" className="secondary-button" onClick={onCancel}>Cancel</button></div>
    </fieldset></form>
}