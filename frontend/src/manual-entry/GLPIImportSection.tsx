import { useEffect, useRef, useState } from 'react'
import { Download, FileUp, Search, Upload } from 'lucide-react'
import { accessFailure, adminRequest, AdminApiError } from '../admin-computers/api'
import { getToken, subscribeAuth } from '../lib/auth'
import type { SessionProps } from './api'

type ImportRow = { row: number; fields: Record<string, string>; issues: string[]; warnings: string[]; category: string; categorySource?: string; isCompute: boolean; status: string }
type Preview = { rows: ImportRow[]; digest: string }
const categories = ['laptop', 'desktop', 'server', 'accessory', 'monitor', 'printer', 'scanner', 'phone', 'network', 'cctv', 'ups']

export function GLPIImportSection({ token, onDenied }: SessionProps) {
  const [csv, setCSV] = useState('')
  const [filename, setFilename] = useState('')
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<Preview | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [reviewed, setReviewed] = useState(false)
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

  async function readFile(file?: File) {
    const version = ++fileVersion.current
    const signal = lifecycle.current?.signal
    setCSV(''); setFilename(''); setPreview(null); setMapping({}); setSelected([]); setConfirmed(false); setReviewed(false); setMessage(''); setError(''); setPage(1)
    if (!file) return
    if (file.size > 8 * 1024 * 1024) { setError('CSV must be no larger than 8 MiB.'); return }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
      if (current() && !signal?.aborted && version === fileVersion.current) { setCSV(text); setFilename(file.name) }
    } catch {
      if (current() && !signal?.aborted && version === fileVersion.current) setError('Could not read this UTF-8 CSV file.')
    }
  }

  async function submit(commit: boolean, categoriesForPreview = mapping, preservePage = false) {
    if (!current() || lock.current || !csv || (commit && (!reviewed || !confirmed || !selected.length))) return
    lock.current = true; setBusy(true); setError(''); setMessage('')
    const digest = preview?.digest
    setConfirmed(false); setReviewed(false)
    try {
      const result = await adminRequest<Preview & { imported: number }>(token, `/admin/glpi/${commit ? 'import' : 'preview'}`, lifecycle.current!.signal, 'POST', {
        csv, categories: categoriesForPreview, ...(commit ? { rows: selected, digest } : {}),
      })
      if (!current()) return
      setSelected([])
      if (!preservePage) setPage(1)
      if (commit) {
        setPreview(null); setMessage(`Imported ${result.imported} assets. Existing assets were not overwritten.`)
      } else {
        setPreview(result); setReviewed(true)
      }
    } catch (failure) {
      if (!current()) return
      if (accessFailure(failure)) { setCSV(''); setPreview(null); onDenied() }
      else if (failure instanceof AdminApiError && failure.status === 400 && !commit) setError(failure.message)
      else setError(commit ? 'Import was not confirmed. Preview again to check existing records before retrying.' : 'Preview unavailable. Check the CSV and try again.')
    } finally {
      if (current()) { lock.current = false; setBusy(false) }
    }
  }

  function changeCategory(type: string, category: string) {
    if (!current() || lock.current) return
    const nextMapping = { ...mapping, [type]: category }
    setMapping(nextMapping); setSelected([]); setConfirmed(false); setReviewed(false)
    void submit(false, nextMapping, true)
  }

  const categorySelect = (type: string, label: string, automaticCategory = '') => <select aria-label={label} className="field mt-1 w-full" disabled={busy} value={mapping[type] || ''} onChange={event => changeCategory(type, event.target.value)}><option value="">{automaticCategory ? `Automatic: ${automaticCategory}` : 'Auto-detect from CSV'}</option>{categories.map(category => <option key={category} value={category}>{category}</option>)}</select>
  const types = [...new Set(preview?.rows.map(row => row.fields.Type || '') ?? [])].sort()
  const filtered = preview?.rows.filter(row => Object.values(row.fields).join(' ').toLowerCase().includes(search.toLowerCase())) ?? []
  const visible = filtered.slice((page - 1) * 25, page * 25)
  const ready = preview?.rows.filter(row => !row.issues.length).length ?? 0
  return <section aria-label="Bulk asset" className="min-w-0 space-y-4">
    <h2 className="flex items-center gap-2 text-xl font-bold"><FileUp size={22} />Bulk asset</h2>
    <a className="secondary-button inline-flex items-center gap-2" href={`${import.meta.env.BASE_URL}templates/bulk-assets.csv`} download="itms-bulk-assets.csv"><Download size={16} />Download CSV template</a>
    <label className="block text-sm font-semibold">Asset CSV file<input type="file" accept=".csv,text/csv" disabled={busy} className="field mt-2 w-full" onChange={event => void readFile(event.target.files?.[0])} /></label>
    {filename && <p className="break-all text-sm text-slate-500">{filename}</p>}
    {types.length > 0 && <fieldset className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"><legend className="mb-2 font-semibold">Category overrides</legend>{types.map(type => <label key={type} className="min-w-0 break-words text-sm">{type || '(Missing GLPI type)'}{categorySelect(type, `Category for ${type || 'missing GLPI type'}`)}</label>)}</fieldset>}
    <button className="secondary-button" disabled={!csv || busy} onClick={() => void submit(false)}><Search size={16} />{busy ? 'Processing...' : 'Preview CSV'}</button>
    {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
    {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
    {preview && <>
      <p role="status" className="text-sm">{reviewed ? `${preview.rows.length} records · ${ready} ready · ${preview.rows.length - ready} blocked` : busy ? 'Validating categories...' : 'Preview required'}</p>
      <label className="block text-sm">Search CSV records<input className="field mt-1 w-full" value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /></label>
      <div className="flex flex-wrap items-center gap-3"><button className="secondary-button" disabled={!reviewed || busy} onClick={() => setSelected(filtered.filter(row => !row.issues.length).slice(0, 200).map(row => row.row))}>Select ready rows (up to 200)</button><button className="secondary-button" disabled={busy} onClick={() => setSelected([])}>Clear selection</button><span className="text-sm">{selected.length} selected</span></div>
      <div className="max-w-full overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['Select', 'Record', 'Asset tag', 'Entity', 'Category / status', 'Review'].map(label => <th key={label} className="border-b p-2">{label}</th>)}</tr></thead><tbody>{visible.map(row => <tr key={row.row}><td className="border-b p-2"><input type="checkbox" aria-label={`Select row ${row.row}`} checked={selected.includes(row.row)} disabled={busy || !reviewed || !!row.issues.length || (!selected.includes(row.row) && selected.length >= 200)} onChange={event => setSelected(previous => event.target.checked ? [...previous, row.row] : previous.filter(value => value !== row.row))} /></td><td className="min-w-48 max-w-80 break-words border-b p-2">{row.fields.Name}<small className="block text-slate-500">Row {row.row} · {!reviewed ? 'Pending validation' : !row.category ? 'Category required' : row.isCompute ? 'Computer' : 'Accessory / equipment'}</small></td><td className="border-b p-2">{row.fields['Inventory/Asset Number'] || 'Missing'}</td><td className="min-w-36 border-b p-2">{row.fields.Entity}</td><td className="min-w-48 border-b p-2"><label className="block break-words">Override all {row.fields.Type || '(Missing GLPI type)'} records{categorySelect(row.fields.Type || '', `Category for row ${row.row} GLPI type`, reviewed && row.categorySource !== 'manual' ? row.category : '')}</label><span className="block mt-1">{reviewed ? row.category || 'Unmapped' : 'Pending validation'} / {row.status || 'Unknown'}</span></td><td className="min-w-64 max-w-96 break-words border-b p-2"><ul>{row.issues.map(issue => <li key={issue} className="text-rose-700">{issue}</li>)}{row.warnings.map(warning => <li key={warning} className="text-amber-700">{warning}</li>)}</ul><details><summary className="cursor-pointer">Source fields</summary><dl>{Object.entries(row.fields).map(([field, value]) => <div key={field}><dt className="font-semibold">{field}</dt><dd className="whitespace-pre-wrap">{value || 'Not recorded'}</dd></div>)}</dl></details></td></tr>)}</tbody></table></div>
      <div className="flex items-center gap-3"><button className="secondary-button" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button><span className="text-sm">Page {page} of {Math.max(1, Math.ceil(filtered.length / 25))}</span><button className="secondary-button" disabled={page * 25 >= filtered.length} onClick={() => setPage(value => value + 1)}>Next</button></div>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy || !reviewed || !selected.length} onChange={event => setConfirmed(event.target.checked)} />I reviewed the selected rows, category mappings and unassigned employee/location warnings.</label>
      <button className="primary-button" disabled={busy || !reviewed || !confirmed || !selected.length} onClick={() => void submit(true)}><Upload size={16} />Import selected assets</button>
    </>}
  </section>
}