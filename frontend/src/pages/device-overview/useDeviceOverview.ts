import { useCallback, useEffect, useRef, useState } from 'react'
import { getToken, subscribeAuth } from '../../lib/auth'
import { parseConnectivity } from './model'
import type { Connectivity, DeviceAlert, DeviceDetail, DeviceHistory } from './model'

type Resource<T> = { data: T | null; loading: boolean; error: string }
const empty = <T,>(): Resource<T> => ({ data: null, loading: false, error: '' })
type RequestKey = 'detail' | 'connectivity' | 'tab'

// Mounted inside a component keyed by account + device. Each channel has its own
// cancellation boundary; even a fetch/body parser that ignores abort cannot win.
export function useDeviceOverview(token: string, assetId: string, tab: string) {
  const [detail, setDetail] = useState(empty<DeviceDetail>)
  const [connectivity, setConnectivity] = useState(empty<Connectivity>)
  const [history, setHistory] = useState(empty<DeviceHistory[]>)
  const [alerts, setAlerts] = useState(empty<DeviceAlert[]>)
  const [denied, setDenied] = useState('')
  const active = useRef(false)
  const revoked = useRef(false)
  const controllers = useRef(new Map<RequestKey, AbortController>())
  const id = encodeURIComponent(assetId)

  const cancel = useCallback((key?: RequestKey) => {
    if (key) { controllers.current.get(key)?.abort(); controllers.current.delete(key) }
    else { controllers.current.forEach(controller => controller.abort()); controllers.current.clear() }
  }, [])

  useEffect(() => {
    active.current = true
    const unsubscribe = subscribeAuth(() => { if (getToken() !== token) cancel() })
    return () => { active.current = false; cancel(); unsubscribe() }
  }, [cancel, token])

  const request = useCallback(async <T,>(key: RequestKey, path: string, accept: (data: T) => void,
    fail: (message: string) => void, finish: () => void, init?: RequestInit, parse?: (data: unknown) => T) => {
    if (!active.current || revoked.current || getToken() !== token) return
    cancel(key)
    const controller = new AbortController()
    controllers.current.set(key, controller)
    const current = () => active.current && !revoked.current && !controller.signal.aborted &&
      controllers.current.get(key) === controller && getToken() === token
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      if (key === 'connectivity') timeout = setTimeout(() => reject(new Error('Backend status request timed out.')), 8_000)
    })
    try {
      const response = await Promise.race([fetch(path, {
        ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
        signal: controller.signal, cache: 'no-store',
      }), deadline])
      if (!current()) return
      if (response.status === 401 || response.status === 403) {
        revoked.current = true
        cancel()
        setDetail(empty()); setConnectivity(empty()); setHistory(empty()); setAlerts(empty())
        setDenied(response.status === 401 ? 'Your session has expired. Sign in to view this device.' : 'Your account does not have access to this device.')
        return
      }
      if (!response.ok) {
        const failure: unknown = await Promise.race([response.json(), deadline]).catch(() => null)
        const message = failure && typeof failure === 'object' && 'error' in failure && typeof failure.error === 'string'
          ? failure.error.trim() : ''
        throw new Error(message || `Request failed (HTTP ${response.status}). Reload the page to try again.`)
      }
      const payload: unknown = await Promise.race([response.json(), deadline])
      if (!current()) return
      accept(parse ? parse(payload) : payload as T)
    } catch (error) {
      if (current()) fail(error instanceof Error ? error.message : 'Endpoint data unavailable')
    } finally {
      clearTimeout(timeout)
      if (current()) { controller.abort(); controllers.current.delete(key); finish() }
    }
  }, [cancel, token])

  const loadDetail = useCallback(() => {
    setDetail(previous => ({ ...previous, loading: true, error: '' }))
    void request<DeviceDetail>('detail', `/api/devices/${id}`,
      data => setDetail({ data, loading: false, error: '' }),
      error => setDetail({ data: null, loading: false, error }), () => {}, undefined,
      data => { if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid device response'); return data as DeviceDetail })
  }, [id, request])

  const loadConnectivity = useCallback(() => {
    setConnectivity(previous => ({ ...previous, loading: true, error: '' }))
    void request<Connectivity>('connectivity', `/api/devices/${id}/connectivity?presence=heartbeat`,
      data => setConnectivity({ data, loading: false, error: '' }),
      error => setConnectivity({ data: null, loading: false, error }), () => {}, undefined, parseConnectivity)
  }, [id, request])

  const loadTab = useCallback(() => {
    if (tab !== 'History' && tab !== 'Alerts') return
    const setter = tab === 'History' ? setHistory : setAlerts
    setter({ data: null, loading: true, error: '' })
    void request<DeviceHistory[] & DeviceAlert[]>('tab', `/api/assets/${id}/${tab.toLowerCase()}`,
      data => setter({ data, loading: false, error: '' }),
      error => setter({ data: null, loading: false, error }), () => {}, undefined,
      data => { if (!Array.isArray(data)) throw new Error(`Invalid ${tab.toLowerCase()} response`); return data })
  }, [id, request, tab])

  useEffect(() => { loadDetail(); return () => cancel('detail') }, [cancel, loadDetail])
  useEffect(() => { loadTab(); return () => cancel('tab') }, [cancel, loadTab])
  useEffect(() => {
    if (denied) return
    loadConnectivity()
    return () => cancel('connectivity')
  }, [cancel, denied, loadConnectivity])

  const refresh = () => {
    if (!active.current || revoked.current || getToken() !== token) return
    loadDetail(); loadConnectivity(); loadTab()
  }

  return { detail, connectivity, history, alerts, denied, refresh }
}