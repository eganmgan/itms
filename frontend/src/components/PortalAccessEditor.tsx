import { useEffect, useRef, useState } from 'react'
import { RotateCcw, Save } from 'lucide-react'
import { getToken } from '../lib/auth'
import { portalRequest, portalSections, type PortalAccess, type PortalSection } from '../lib/portalAccess'

export function PortalAccessEditor({ userId, token }: { userId: string; token: string }) {
  const [access, setAccess] = useState<PortalAccess>()
  const [sections, setSections] = useState<PortalSection[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)
  const session = useRef<AbortController>()
  const saving = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    session.current = controller
    saving.current = false
    setBusy(false); setAccess(undefined); setError(''); setNotice('')
    void portalRequest(token, `/users/${encodeURIComponent(userId)}/portal-access`, controller.signal).then(value => {
      if (!controller.signal.aborted) { setAccess(value); setSections(value.sections) }
    }).catch(() => { if (!controller.signal.aborted) setError('Unable to load portal sections.') })
    return () => controller.abort()
  }, [userId, token, revision])
  async function save(useDefaults = false) {
    const controller = session.current
    if (saving.current || !access || access.role === 'super_admin' || token !== getToken() || !controller || controller.signal.aborted) return
    saving.current = true
    setBusy(true); setError(''); setNotice('')
    try {
      const value = await portalRequest(token, `/users/${encodeURIComponent(userId)}/portal-access`, controller.signal, useDefaults ? { useDefaults: true } : { sections })
      if (controller.signal.aborted) return
      setAccess(value); setSections(value.sections); setNotice('Portal sections saved.')
    } catch { if (!controller.signal.aborted) { setError('Save not confirmed. Reload sections before trying again.'); setAccess(undefined) } }
    finally { if (!controller.signal.aborted) { saving.current = false; setBusy(false) } }
  }
  return <section className="space-y-3 border-t pt-5" aria-label="Portal sections">
    <h3 className="text-sm font-semibold">Portal sections</h3>
    {access?.readOnly && <p className="text-xs text-slate-500">Read-only</p>}
    {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
    {notice && <p role="status" className="text-sm text-emerald-700">{notice}</p>}
    {!access && !error && <p role="status" className="text-sm">Loading portal sections...</p>}
    {access && <fieldset disabled={busy || access.role === 'super_admin'} className="flex flex-wrap gap-4">
      {portalSections.map(section => <label key={section} className="flex items-center gap-2 text-sm capitalize"><input type="checkbox" checked={sections.includes(section)} onChange={event => setSections(current => event.target.checked ? [...current, section] : current.filter(value => value !== section))} />{section}</label>)}
    </fieldset>}
    <div className="flex gap-2">
      <button className="primary-button" disabled={busy || !access || access.role === 'super_admin'} onClick={() => void save()}><Save size={16} />Save sections</button>
      <button className="secondary-button" disabled={busy || !access || access.role === 'super_admin'} onClick={() => void save(true)}><RotateCcw size={16} />Role defaults</button>
      {error && <button className="secondary-button" disabled={busy} onClick={() => setRevision(value => value + 1)}>Reload sections</button>}
    </div>
  </section>
}