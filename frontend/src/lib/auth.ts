import { useEffect, useSyncExternalStore } from 'react'
import { readJson } from './api'

const apiBase = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
export const getToken = () => localStorage.getItem('itms_token') || ''
export const isAdminRole = (role: unknown) => role === 'admin' || role === 'super_admin'
const activityKey = 'itms-last-activity'
export const idleLogoutMs = 10 * 60 * 1000

export function signOut(expectedToken = getToken()) {
  if (getToken() !== expectedToken) return
  for (const key of ['itms_token', 'auth_token', 'token', 'itms_user', 'itms-login-identity', 'itms-assistant-history', activityKey]) localStorage.removeItem(key)
  window.dispatchEvent(new Event('itms-auth-changed'))
  window.dispatchEvent(new Event('itms-signed-out'))
  if (expectedToken) void fetch(`${apiBase}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${expectedToken}` } }).catch(() => undefined)
}

export function useIdleLogout(token: string) {
  useEffect(() => {
    if (!token) return
    let timer: ReturnType<typeof setTimeout>
    const readActivity = () => {
      const stored = Number(localStorage.getItem(activityKey))
      return Number.isFinite(stored) && stored > 0 ? Math.min(stored, Date.now()) : Date.now()
    }
    const check = () => {
      clearTimeout(timer)
      if (getToken() !== token) return false
      const remaining = readActivity() + idleLogoutMs - Date.now()
      if (remaining <= 0) {
        signOut(token)
        return false
      }
      timer = setTimeout(check, remaining)
      return true
    }
    const activity = () => {
      if (!check() || document.visibilityState === 'hidden') return
      localStorage.setItem(activityKey, String(Date.now()))
      check()
    }
    const storage = (event: StorageEvent) => {
      if (event.key === activityKey || event.key === 'itms_token' || event.key === null) check()
    }
    const events = ['pointerdown', 'pointermove', 'keydown', 'scroll', 'wheel', 'touchstart'] as const
    localStorage.setItem(activityKey, String(readActivity()))
    check()
    for (const event of events) window.addEventListener(event, activity, { capture: true, passive: true })
    window.addEventListener('storage', storage)
    window.addEventListener('focus', check)
    window.addEventListener('pageshow', check)
    document.addEventListener('visibilitychange', check)
    return () => {
      clearTimeout(timer)
      for (const event of events) window.removeEventListener(event, activity, true)
      window.removeEventListener('storage', storage)
      window.removeEventListener('focus', check)
      window.removeEventListener('pageshow', check)
      document.removeEventListener('visibilitychange', check)
    }
  }, [token])
}

export function subscribeAuth(notify: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === 'itms_token' || event.key === null) notify()
  }
  window.addEventListener('itms-auth-changed', notify)
  window.addEventListener('storage', storage)
  return () => {
    window.removeEventListener('itms-auth-changed', notify)
    window.removeEventListener('storage', storage)
  }
}

export function useAuthToken() {
  return useSyncExternalStore(subscribeAuth, getToken)
}

export type LoginResult = { kind: 'mfa'; email: string } | { kind: 'authenticated'; token: string }

// Keep the existing API boundary: password login, then email/code verification.
// Client-side sequencing is not a substitute for server-side MFA enforcement.
async function requestLogin(path: string, body: object, signal?: AbortSignal): Promise<LoginResult> {
  const response = await fetch(`${apiBase}/auth/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  })
  const payload = await readJson<{ token?: unknown; mfaRequired?: unknown; email?: unknown; error?: unknown; message?: unknown } | null>(response)
  if (!response.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : typeof payload?.message === 'string' ? payload.message : 'Sign in failed. Check your credentials and try again.')
  if (payload?.mfaRequired) {
    if (typeof payload.email !== 'string' || !payload.email.trim()) throw new Error('MFA email was not returned. Contact your administrator.')
    return { kind: 'mfa', email: payload.email.trim() }
  }
  if (typeof payload?.token !== 'string' || !payload.token.trim()) throw new Error('Authentication token was not returned. Please try again.')
  return { kind: 'authenticated', token: payload.token.trim() }
}

export function login(identity: string, password: string, signal?: AbortSignal) {
  if (!identity.trim() || !password) return Promise.reject(new Error('Enter your employee ID or email and password.'))
  return requestLogin('login', { identity: identity.trim(), password }, signal)
}

export function verifyMfa(email: string, code: string, signal?: AbortSignal) {
  if (!email.trim() || !code.trim()) return Promise.reject(new Error('Enter your MFA code.'))
  return requestLogin('login/verify-mfa', { email: email.trim(), code: code.trim() }, signal)
}

export function saveSession(token: string, identity = '') {
  if (!token.trim()) throw new Error('Authentication token was not returned.')
  localStorage.removeItem('itms-assistant-history')
  if (identity.trim()) localStorage.setItem('itms-login-identity', identity)
  else localStorage.removeItem('itms-login-identity')
  localStorage.setItem(activityKey, String(Date.now()))
  localStorage.setItem('itms_token', token)
  window.dispatchEvent(new Event('itms-auth-changed'))
}