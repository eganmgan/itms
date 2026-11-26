import { getToken } from './auth'

type BrowserFailure = { page: string; count: number; lastSeen: string }
let owner = ''
let failures: BrowserFailure[] = []

export function browserFailures(token: string) {
  if (token !== getToken() || token !== owner) { failures = []; owner = token === getToken() ? token : '' }
  return failures.map(failure => ({ ...failure }))
}

export function recordBrowserFailure(token: string, page: string) {
  if (!token || getToken() !== token) return
  browserFailures(token)
  const existing = failures.find(failure => failure.page === page)
  if (existing) { existing.count++; existing.lastSeen = new Date().toISOString() }
  else failures = [...failures.slice(-19), { page, count: 1, lastSeen: new Date().toISOString() }]
}