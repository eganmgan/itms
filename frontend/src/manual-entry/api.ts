import { useEffect, useRef, useState } from 'react'
import { accessFailure, AdminApiError, useAdminResource } from '../admin-computers/api'
import { getToken, subscribeAuth } from '../lib/auth'
import { notifyRecordChange } from '../lib/recordChanges'

export type SessionProps = { token: string; onDenied: () => void }
export type Entity = { id: string; short_code: string; full_name: string; is_active: boolean }
export type Department = { id: string; entity_id: string; name: string; short_code: string }
export type Location = { id: string; entity_id: string; full_name: string; location_code: string; is_active: boolean }
export type Employee = { id: string; full_name: string; emp_id: string; email: string; department: string | null; location: string | null; status: string }
export type EmployeeList = { items: Employee[]; total: number; page: number; pageSize: number }
export const inputClass = 'field mt-1 w-full'

// Never display arbitrary API errors: legacy endpoints can include SQL details
// or reflect submitted values. In particular, a password must never be echoed.
export function safeError(error: unknown) {
  if (accessFailure(error)) return 'Access denied. Settings data has been cleared.'
  if (error instanceof AdminApiError) {
    if (error.status === 409) return 'A record with this email, employee ID, name or code already exists. Check existing records before retrying.'
    if (error.status === 400 || error.status === 422) return 'The server rejected these fields. Check required values, email domain, relationships and duplicate email, employee ID or code.'
    if (error.status === 429) return 'Too many requests. Please try again later.'
  }
  return 'Request unavailable. Check existing records before retrying a create; it may already have been saved.'
}

export function useManualResource<T>({ token, onDenied }: SessionProps, path: string | null, revision = 0) {
  const result = useAdminResource<T>(token, path, revision)
  const denied = accessFailure(result.error)
  useEffect(() => { if (denied) onDenied() }, [denied, onDenied])
  return { data: denied ? undefined : result.data, loading: result.loading, error: result.error ? safeError(result.error) : '' }
}

export function useManualWrite({ token, onDenied }: SessionProps) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const lifecycle = useRef<AbortController | null>(null)
  const lock = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    const unsubscribe = subscribeAuth(() => { if (getToken() !== token) controller.abort() })
    return () => { controller.abort(); unsubscribe() }
  }, [token])
  async function save(path: string, body: object, onSaved: () => void, method = 'POST') {
    const controller = lifecycle.current
    const current = () => !!controller && !controller.signal.aborted && !!token && getToken() === token
    if (!current() || lock.current) return
    lock.current = true; setSaving(true); setError('')
    try {
      const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
      const response = await fetch(`${base}${path}`, { method, signal: controller!.signal, cache: 'no-store', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!current()) return
      // Only status matters for these writes. Never parse/store/render a response
      // body that might accidentally echo a credential, even on success.
      if (!response.ok) throw new AdminApiError('Settings request failed.', response.status)
      if (/^\/(entities|locations|departments)(\/|$|\?)/.test(path)) notifyRecordChange()
      onSaved()
    } catch (failure) {
      if (current()) {
        if (accessFailure(failure)) onDenied()
        else setError(safeError(failure))
      }
    } finally {
      if (current()) { lock.current = false; setSaving(false) }
    }
  }
  return { save, saving, error, setError }
}