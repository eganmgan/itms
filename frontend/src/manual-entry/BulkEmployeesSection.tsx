import { useEffect, useRef, useState } from 'react'
import { Download, Search, Upload, Users } from 'lucide-react'
import { accessFailure, adminRequest, AdminApiError } from '../admin-computers/api'
import { getToken, subscribeAuth } from '../lib/auth'
import { useManualResource, type Entity, type SessionProps } from './api'

type Row = { row: number; empId: string; fullName: string; email: string; issues: string[] }
type Preview = { rows: Row[]; digest: string }

export function BulkEmployeesSection(props: SessionProps) {
  const { token, onDenied } = props
  const entities = useManualResource<Entity[]>(props, '/entities')
  const [entityId, setEntityId] = useState('')
  const [csv, setCSV] = useState('')
  const [filename, setFilename] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const lifecycle = useRef<AbortController | null>(null)
  const lock = useRef(false)
  const fileVersion = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    const unsubscribe = subscribeAuth(() => { if (getToken() !== token) controller.abort() })
    return () => { controller.abort(); unsubscribe() }
  }, [token])
  const current = () => !!lifecycle.current && !lifecycle.current.signal.aborted && getToken() === token
  function invalidate() { setPreview(null); setSelected([]); setConfirmed(false); setPage(1); setError(''); setMessage('') }
  async function readFile(file?: File) {
    const version = ++fileVersion.current
    const signal = lifecycle.current?.signal
    invalidate(); setCSV(''); setFilename(''); setSearch('')
    if (!file) return
    if (file.size > 1024 * 1024) { setError('CSV must be no larger than 1 MiB.'); return }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      if (current() && !signal?.aborted && version === fileVersion.current) { setCSV(text); setFilename(file.name) }
    } catch { if (current() && !signal?.aborted && version === fileVersion.current) setError('Could not read this UTF-8 CSV file.') }
  }
  async function submit(commit: boolean) {
    if (!current() || lock.current || !csv || !entityId || (commit && (!preview || !confirmed || !selected.length))) return
    lock.current = true; setBusy(true); setError(''); setMessage(''); setConfirmed(false)
    const reviewed = preview
    try {
      const result = await adminRequest<Preview & { created: number }>(token, `/admin/employees/${commit ? 'import' : 'preview'}`, lifecycle.current!.signal, 'POST', { csv, entityId, ...(commit ? { rows: selected, digest: reviewed?.digest } : {}) })
      if (!current()) return
      setSelected([]); setPage(1)
      if (commit) { setPreview(null); setMessage(`Created ${result.created} inactive employee accounts. Passwords are not set. Existing accounts were not changed.`) }
      else setPreview(result)
    } catch (failure) {
      if (!current()) return
      setPreview(null); setSelected([])
      if (accessFailure(failure)) { setCSV(''); onDenied() }
      else if (!commit && failure instanceof AdminApiError && failure.status === 400) setError(failure.message)
      else setError(commit ? 'Creation was not confirmed. Preview again to check existing accounts before retrying.' : 'Preview unavailable. Check the CSV and company, then try again.')
    } finally { if (current()) { lock.current = false; setBusy(false) } }
  }
  const filtered = preview?.rows.filter(row => `${row.empId} ${row.fullName} ${row.email} ${row.issues.join(' ')}`.toLowerCase().includes(search.toLowerCase())) ?? []
  const ready = preview?.rows.filter(row => row.issues.length === 0).length ?? 0
  return <section aria-label="Bulk employee accounts" className="min-w-0 space-y-4">
    <h2 className="flex items-center gap-2 text-xl font-bold"><Users size={22} />Bulk employee accounts</h2>
    <a className="secondary-button inline-flex items-center gap-2" href={`${import.meta.env.BASE_URL}templates/bulk-employees.csv`} download="itms-bulk-employees.csv"><Download size={16} />Download CSV template</a>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="block text-sm">Company<select className="field mt-1 w-full" value={entityId} disabled={busy || entities.loading} onChange={event => { setEntityId(event.target.value); invalidate() }}><option value="">Select company</option>{entities.data?.filter(entity => entity.is_active).map(entity => <option key={entity.id} value={entity.id}>{entity.short_code} · {entity.full_name}</option>)}</select></label>
      <label className="block text-sm">Employee CSV file<input type="file" accept=".csv,text/csv" className="field mt-1 w-full" disabled={busy} onChange={event => void readFile(event.target.files?.[0])} /></label>
    </div>
    {filename && <p className="break-all text-sm text-slate-500">{filename}</p>}
    <p className="text-sm text-slate-500">New accounts: employee role, inactive, password not set. Existing accounts: unchanged.</p>
    <button className="secondary-button" disabled={busy || !csv || !entityId} onClick={() => void submit(false)}><Search size={16} />{busy ? 'Processing...' : 'Preview employees'}</button>
    {(error || entities.error) && <p role="alert" className="text-sm text-rose-700">{error || entities.error}</p>}
    {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
    {preview && <>
      <p role="status" className="text-sm">{preview.rows.length} records · {ready} ready · {preview.rows.length - ready} blocked</p>
      <label className="block text-sm">Search employee rows<input className="field mt-1 w-full" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></label>
      <div className="flex flex-wrap items-center gap-3"><button className="secondary-button" disabled={busy} onClick={() => { setSelected(filtered.filter(row => !row.issues.length).slice(0, 200).map(row => row.row)); setConfirmed(false) }}>Select ready employees (up to 200)</button><button className="secondary-button" disabled={busy} onClick={() => { setSelected([]); setConfirmed(false) }}>Clear selection</button><span className="text-sm">{selected.length} selected</span></div>
      <div className="max-w-full overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['Select', 'Employee ID', 'Name', 'Email', 'Review'].map(title => <th className="border-b p-2" key={title}>{title}</th>)}</tr></thead><tbody>{filtered.slice((page - 1) * 25, page * 25).map(row => <tr key={row.row}>
        <td className="border-b p-2"><input type="checkbox" aria-label={`Select employee row ${row.row}`} disabled={busy || !!row.issues.length || (!selected.includes(row.row) && selected.length >= 200)} checked={selected.includes(row.row)} onChange={event => { setConfirmed(false); setSelected(previous => event.target.checked ? [...previous, row.row] : previous.filter(value => value !== row.row)) }} /></td>
        <td className="border-b p-2">{row.empId}</td><td className="min-w-40 border-b p-2">{row.fullName}</td><td className="break-all border-b p-2">{row.email}</td><td className="min-w-48 border-b p-2">{row.issues.length ? <ul>{row.issues.map(issue => <li key={issue} className="text-rose-700">{issue}</li>)}</ul> : 'Ready: inactive employee'}</td>
      </tr>)}</tbody></table></div>
      <div className="flex items-center gap-3"><button className="secondary-button" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button><span className="text-sm">Page {page} of {Math.max(1, Math.ceil(filtered.length / 25))}</span><button className="secondary-button" disabled={page * 25 >= filtered.length} onClick={() => setPage(value => value + 1)}>Next</button></div>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy || !selected.length} onChange={event => setConfirmed(event.target.checked)} />I reviewed these new accounts and the selected company. Create inactive employees without passwords.</label>
      <button className="primary-button" disabled={busy || !confirmed || !selected.length} onClick={() => void submit(true)}><Upload size={16} />Create selected employees</button>
    </>}
  </section>
}