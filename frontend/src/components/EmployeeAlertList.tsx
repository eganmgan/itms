import { useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import { subscribeAuth, useAuthToken } from '../lib/auth'
import { Badge } from './ui'

export interface EmployeeAlert { id: string; hostname?: string; assetName?: string; assetTag?: string; title: string; detail: string; severity: string; resolved: boolean; source?: string; sourceLabel?: string; createdAt?: string }

export function EmployeeAlertList({ alerts }: { alerts: EmployeeAlert[] }) {
  const token = useAuthToken()
  return <AlertList key={token} token={token} alerts={alerts} />
}

function AlertList({ token, alerts }: { token: string; alerts: EmployeeAlert[] }) {
  const [sending, setSending] = useState('')
  const [results, setResults] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    const unsubscribe = subscribeAuth(() => { if (token !== localStorage.getItem('itms_token')) controller.current?.abort() })
    return () => { controller.current?.abort(); unsubscribe() }
  }, [token])
  async function send(alert: EmployeeAlert) {
    if (!token || token !== localStorage.getItem('itms_token') || controller.current || results[alert.id]) return
    const active = new AbortController()
    controller.current = active
    setSending(alert.id); setError('')
    const timeout = window.setTimeout(() => active.abort(), 10000)
    try {
      const response = await fetch('/api/me/requests', { method: 'POST', cache: 'no-store', signal: active.signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({
        type: 'security_alert', title: `Security alert: ${alert.title}`.slice(0, 200),
        description: `Alert ID: ${alert.id}\nDevice: ${alert.hostname || alert.assetName || 'Not recorded'}\nSource: ${alert.sourceLabel || alert.source || 'Not recorded'}\nSeverity: ${alert.severity}\nDetected: ${alert.createdAt || 'Not recorded'}\nStatus: ${alert.resolved ? 'Resolved' : 'Open'}\n\n${alert.title}\n${alert.detail}`,
        priority: ['critical', 'high', 'low'].includes(alert.severity.toLowerCase()) ? alert.severity.toLowerCase() : 'medium',
      }) })
      if (response.status === 401 || response.status === 403) {
        if (token === localStorage.getItem('itms_token') && !active.signal.aborted) setError('Request access unavailable. Contact your administrator.')
        return
      }
      if (!response.ok) throw new Error('Submission unavailable')
      const result = await response.json() as { id?: string; ticketNumber?: string }
      if (!result.id) throw new Error('Submission unconfirmed')
      if (!active.signal.aborted && token === localStorage.getItem('itms_token')) setResults(current => ({ ...current, [alert.id]: `Sent to IT: ${result.ticketNumber || result.id}` }))
    } catch {
      if (token === localStorage.getItem('itms_token')) setResults(current => ({ ...current, [alert.id]: 'Submission not confirmed. Check request history before sending again.' }))
    } finally { window.clearTimeout(timeout); controller.current = null; setSending('') }
  }
  return <div className="space-y-3">
    {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
    {!alerts.length && <p className="py-4 text-sm text-slate-500">No security alerts.</p>}
    {alerts.map(alert => <article key={alert.id} className="space-y-3 border-b py-4" aria-label={alert.title}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words font-semibold">{alert.title}</h3><p className="mt-1 break-words text-xs text-slate-500">{alert.hostname || alert.assetName || 'Device not recorded'}{alert.assetTag ? ` · ${alert.assetTag}` : ''} · {alert.sourceLabel || alert.source || 'Source not recorded'}</p></div><div className="flex gap-2"><Badge tone={alert.severity === 'critical' ? 'rose' : alert.severity === 'high' ? 'amber' : 'blue'}>{alert.severity || 'Info'}</Badge><Badge tone={alert.resolved ? 'green' : 'amber'}>{alert.resolved ? 'Resolved' : 'Open'}</Badge></div></div>
      <p className="whitespace-pre-wrap break-words text-sm">{alert.detail || 'No additional alert details recorded.'}</p>
      <div className="flex flex-wrap items-center justify-between gap-3"><time className="text-xs text-slate-500">{alert.createdAt ? new Date(alert.createdAt).toLocaleString() : 'Detection time not recorded'}</time>{results[alert.id] ? <p role="status" className="max-w-md text-sm">{results[alert.id]}</p> : <button className="secondary-button" disabled={!!sending || !token} onClick={() => void send(alert)} aria-label={`Send to IT: ${alert.title}`}><Send size={15} />{sending === alert.id ? 'Sending...' : 'Send to IT'}</button>}</div>
    </article>)}
  </div>
}