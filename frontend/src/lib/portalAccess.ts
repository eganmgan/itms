import { createContext, useContext, useEffect, useState } from 'react'
import { getToken, subscribeAuth } from './auth'

export const portalSections = ['devices', 'patch', 'security', 'employee', 'gatepass'] as const
export type PortalSection = typeof portalSections[number]
export type PortalAccess = { role: string; sections: PortalSection[]; readOnly: boolean; customized: boolean }
export const PortalReadOnlyContext = createContext(false)
export const usePortalReadOnly = () => useContext(PortalReadOnlyContext)
export function parsePortalAccess(value: unknown): PortalAccess {
  const access = value as Partial<PortalAccess> | null
  if (!access || typeof access.role !== 'string') throw new Error('Portal access unavailable.')
  const sections = Array.isArray(access.sections) ? access.sections.filter((section): section is PortalSection => portalSections.includes(section as PortalSection)) : []
  if (access.sections !== undefined && !Array.isArray(access.sections)) throw new Error('Portal access unavailable.')
  if (access.sections && access.sections.some(section => !portalSections.includes(section))) throw new Error('Portal access unavailable.')
  const readOnly = typeof access.readOnly === 'boolean' ? access.readOnly : false
  const customized = typeof access.customized === 'boolean' ? access.customized : false
  return { role: access.role, sections, readOnly: access.role === 'auditor' || readOnly, customized }
}
export async function portalRequest(token: string, path: string, signal: AbortSignal, body?: object): Promise<PortalAccess> {
  if (!token || token !== getToken() || signal.aborted) throw new Error('Account changed.')
  const response = await fetch(`/api${path}`, { method: body ? 'PUT' : 'GET', signal, cache: 'no-store', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  if (!response.ok) throw new Error(response.status === 403 ? 'Portal access denied.' : 'Portal access unavailable.')
  const value = await response.json()
  if (token !== getToken() || signal.aborted) throw new Error('Account changed.')
  return parsePortalAccess(value)
}
export function usePortalAccess(token: string) {
  const [state, setState] = useState<{ token: string; access?: PortalAccess; error?: string }>({ token: '' })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    let pending = false
    const load = async () => {
      if (pending || document.visibilityState === 'hidden') return
      pending = true
      const request = new AbortController()
      const abort = () => request.abort()
      controller.signal.addEventListener('abort', abort, { once: true })
      const timeout = window.setTimeout(abort, 8000)
      try {
        const access = await portalRequest(token, '/me/portal-access', request.signal)
        if (!controller.signal.aborted) setState({ token, access })
      } catch {
        if (!controller.signal.aborted && getToken() === token) setState({ token, error: 'Unable to verify portal access.' })
      } finally { window.clearTimeout(timeout); controller.signal.removeEventListener('abort', abort); pending = false }
    }
    const unsubscribe = subscribeAuth(() => { if (getToken() !== token) controller.abort() })
    const visible = () => { if (document.visibilityState === 'visible') void load() }
    void load()
    const timer = window.setInterval(visible, 60000)
    window.addEventListener('focus', visible)
    document.addEventListener('visibilitychange', visible)
    return () => { controller.abort(); unsubscribe(); window.clearInterval(timer); window.removeEventListener('focus', visible); document.removeEventListener('visibilitychange', visible) }
  }, [token, revision])
  const current = token && state.token === token && getToken() === token ? state : undefined
  return { access: current?.access, error: current?.error, loading: !!token && !current, retry: () => { setState({ token: '' }); setRevision(value => value + 1) } }
}