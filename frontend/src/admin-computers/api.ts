import { useEffect, useState } from 'react'
import { getToken, isAdminRole, subscribeAuth, useAuthToken } from '../lib/auth'
import { readJson } from '../lib/api'
import { subscribeRecordChanges } from '../lib/recordChanges'

export type Option = { id: string; name: string }
export type Options = Record<'entities' | 'locations' | 'departments' | 'users' | 'technicians' | 'suppliers', Option[]>
export type Computer = {
  id: string; isCompute: true; warrantyUntil: string | null
  entityId: string; assetTag: string; name: string; category: string; status: string
  hostname: string | null; manufacturer: string | null; model: string | null; serialNumber: string | null
  locationId: string | null; deptId: string | null; assignedUserId: string | null
  technicianInChargeId: string | null; groupInChargeId: string | null; supplierId: string | null
  purchaseDate: string | null; cost: string | null; warrantyStartDate: string | null
  warrantyDurationMonths: number | null; updateSources: string | null
  osName: string | null; architecture: string | null; notes: string | null
}
export type ComputerList = { items: Computer[]; total: number; page: number; pageSize: number }
export type ComputerPayload = Partial<Omit<Computer, 'id' | 'isCompute' | 'warrantyUntil'>>
export const canManageComputers = isAdminRole
const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

export class AdminApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}
export const accessFailure = (error: unknown) => error instanceof AdminApiError && (error.status === 401 || error.status === 403)

export async function adminRequest<T>(token: string, path: string, signal: AbortSignal, method = 'GET', body?: object): Promise<T> {
  const current = () => {
    if (signal.aborted || !token || getToken() !== token) throw new DOMException('Account changed', 'AbortError')
  }
  current()
  const response = await fetch(`${base}${path}`, {
    method, signal, cache: 'no-store', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  current()
  // Never render a denied response body: it may contain details from a proxy/server.
  if (response.status === 401) throw new AdminApiError('Session expired. Sign in again.', 401)
  if (response.status === 403) throw new AdminApiError('Access denied. This account cannot manage computers in this scope.', 403)
  const data = await readJson<T & { error?: unknown }>(response)
  current()
  if (!response.ok) throw new AdminApiError(typeof data?.error === 'string' ? data.error : `Computer request failed (HTTP ${response.status}).`, response.status)
  return data
}

// The resource key hides old data during render, before effect cleanup runs.
// Abort AND ignore late responses (including transports that ignore AbortSignal).
export function useAdminResource<T>(token: string, path: string | null, revision = 0) {
  const accountToken = useAuthToken()
  const active = !!token && token === accountToken
  const [recordRevision, refreshRecords] = useState(0)
  const recordOptions = !!path && /^\/(entities|locations|departments|admin\/assets\/options)(\?|$)/.test(path)
  useEffect(() => {
    if (!active || !recordOptions) return
    return subscribeRecordChanges(() => refreshRecords(value => value + 1))
  }, [active, recordOptions])
  const key = JSON.stringify([token, path, revision, active])
  const [state, setState] = useState<{ key: string; data?: T; error?: Error }>({ key: '' })
  useEffect(() => {
    if (!path || !active) return
    const controller = new AbortController()
    const unsubscribe = subscribeAuth(() => { if (getToken() !== token) controller.abort() })
    void adminRequest<T>(token, path, controller.signal).then(data => {
      if (!controller.signal.aborted && getToken() === token) setState({ key, data })
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && getToken() === token) setState({ key, error: error instanceof Error ? error : new Error('Computer request failed.') })
    })
    return () => { controller.abort(); unsubscribe() }
  }, [token, path, key, active, recordRevision])
  return active && state.key === key ? { ...state, loading: false } : { data: undefined, error: undefined, loading: !!path && active }
}

export function useAdminAccess(token: string) {
  const [revision, retry] = useState(0)
  const [denied, setDenied] = useState(false)
  const me = useAdminResource<{ role?: unknown }>(token, token ? '/auth/me' : null, revision)
  return {
    allowed: !denied && canManageComputers(me.data?.role), loading: me.loading,
    isSuperAdmin: !denied && me.data?.role === 'super_admin',
    error: me.error, denied: denied || (!!me.data && !canManageComputers(me.data.role)),
    revoke: () => setDenied(true), retry: () => { setDenied(false); retry(value => value + 1) },
  }
}