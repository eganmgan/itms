import { useEffect, useRef, useState } from 'react'
import { Pencil, Save } from 'lucide-react'
import { Modal } from '../components/ui'
import { getToken, subscribeAuth, useAuthToken } from '../lib/auth'

export type LifecycleDetail = {
  canEditLifecycle?: boolean
  supplier?: { name?: string | null } | null
  purchaseDate?: string | null
  cost?: string | number | null
  warrantyStartDate?: string | null
  warrantyDurationMonths?: string | number | null
  warrantyExpiresAt?: string | null
  addedOn?: string | null
  scrappedOn?: string | null
}

const groups = [
  { title: 'Management - Asset Lifecycle', fields: [['addedOn', 'Added date', 'date'], ['purchaseDate', 'Purchase date', 'date'], ['scrappedOn', 'Scrapped date', 'date']] },
  { title: 'Financial & Administrative Information', fields: [['supplierName', 'Supplier', 'text'], ['cost', 'Value', 'number']] },
  { title: 'Warranty Information', fields: [['warrantyStartDate', 'Warranty start date', 'date'], ['warrantyDurationMonths', 'Warranty duration (months)', 'number'], ['warrantyExpiresAt', 'Warranty expiry date', 'date']] },
] as const
type Field = typeof groups[number]['fields'][number][0]
type Draft = Record<Field, string>

function draftFrom(detail: LifecycleDetail): Draft {
  return {
    supplierName: detail.supplier?.name ?? '', purchaseDate: detail.purchaseDate ?? '',
    cost: String(detail.cost ?? ''), warrantyStartDate: detail.warrantyStartDate ?? '',
    warrantyDurationMonths: String(detail.warrantyDurationMonths ?? ''), warrantyExpiresAt: detail.warrantyExpiresAt ?? '',
    addedOn: detail.addedOn ?? '', scrappedOn: detail.scrappedOn ?? '',
  }
}

export function DeviceLifecycleEditor({ assetId, detail, onSaved }: { assetId: string; detail: LifecycleDetail; onSaved: () => void }) {
  const token = useAuthToken()
  return <EditorSession key={`${token}:${assetId}`} token={token ?? ''} assetId={assetId} detail={detail} onSaved={onSaved} />
}

function EditorSession({ token, assetId, detail, onSaved }: { token: string; assetId: string; detail: LifecycleDetail; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(() => draftFrom(detail))
  const [saving, setSaving] = useState(false)
  const [locked, setLocked] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const active = useRef(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    active.current = true
    const unsubscribe = subscribeAuth(() => { if (getToken() !== token) controller.current?.abort() })
    return () => { active.current = false; controller.current?.abort(); unsubscribe() }
  }, [token])
  const allowed = !!token && detail.canEditLifecycle === true && !locked

  const save = async () => {
    if (!allowed || pending.current || getToken() !== token) return
    const initial = draftFrom(detail)
    const changed = Object.fromEntries(Object.entries(draft).filter(([key, value]) => value !== initial[key as Field]))
    if (!Object.keys(changed).length) { setError('No changes to save.'); return }
    pending.current = true
    setSaving(true); setError('')
    const request = new AbortController()
    controller.current = request
    const current = () => active.current && getToken() === token && !request.signal.aborted
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Save result unknown. Reload the page before editing again.')), 10_000) })
    try {
      const response = await Promise.race([fetch(`/api/devices/${encodeURIComponent(assetId)}/lifecycle`, {
        method: 'PATCH', signal: request.signal, cache: 'no-store',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(changed),
      }), deadline])
      const payload: unknown = await Promise.race([response.json(), deadline])
      if (!current()) return
      if (!response.ok) {
        if (response.status === 409 || response.status === 401 || response.status === 403 || response.status >= 500) setLocked(true)
        const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : 'Asset details could not be saved.'
        setError(message)
        return
      }
      if (!payload || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== true) throw new Error('Save result unknown. Reload the page before editing again.')
      setLocked(!('canEditLifecycle' in payload) || payload.canEditLifecycle !== true)
      setOpen(false)
      onSaved()
    } catch {
      if (current()) { setLocked(true); setError('Save result unknown. Reload the page before editing again.') }
    } finally {
      clearTimeout(timeout)
      request.abort()
      pending.current = false
      if (active.current && getToken() === token) setSaving(false)
    }
  }

  if (!token || detail.canEditLifecycle !== true) return null
  return <>
    <button className="secondary-button" disabled={!allowed || saving} onClick={() => { setDraft(draftFrom(detail)); setError(''); setOpen(true) }}><Pencil size={16} />Edit asset details</button>
    {open && <Modal title="Edit asset details" onClose={() => { if (!pending.current) setOpen(false) }}>
      <form className="min-w-0 space-y-5 p-5" onSubmit={event => { event.preventDefault(); void save() }}>
        {groups.map(group => <fieldset key={group.title} disabled={saving || locked} className="min-w-0 border-0 p-0">
          <legend className="mb-3 text-sm font-bold">{group.title}</legend>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">{group.fields.map(([key, label, type]) => <label key={key} className="min-w-0 text-xs font-semibold">{label}
            <input className="field mt-2 w-full min-w-0" type={type} value={draft[key]} min={type === 'number' ? 0 : '0001-01-01'} max={type === 'date' ? '9999-12-31' : key === 'warrantyDurationMonths' ? 1200 : key === 'cost' ? '9999999999.99' : undefined} maxLength={key === 'supplierName' ? 150 : undefined} step={key === 'cost' ? '0.01' : type === 'number' ? 1 : undefined} onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))} />
          </label>)}</div>
        </fieldset>)}
        {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2"><button type="button" className="secondary-button" disabled={saving} onClick={() => setOpen(false)}>Cancel</button><button type="submit" className="primary-button" disabled={!allowed || saving}><Save size={16} />{saving ? 'Saving...' : 'Save'}</button></div>
      </form>
    </Modal>}
  </>
}