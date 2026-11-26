import { useEffect, useState } from 'react'
import { getToken, subscribeAuth } from './auth'
import { readJson } from './api'

export interface PatchEndpoint { id: string; hostname: string; assetTag?: string; assetId?: string; user?: { email?: string | null } | null }
export interface CollectionSection {
  status?: string; source?: string; scanned_at?: string; error?: string; scope?: string
  total?: number; returned?: number; truncated?: boolean; truncated_count?: number
}
export interface DeviceInventory {
  id: string; entityId: string; hostname?: string; assetTag?: string; osName?: string; lastSeenAt?: string
  installedApps?: Array<{ id?: string; name: string; version?: string; source?: string }>
  services?: Array<{ name: string; display_name?: string; state?: string; start_mode?: string; source?: string }>
  collectionStatus?: Record<string, CollectionSection>
  servicesLastSuccessAt?: string; servicesUpdatedAt?: string
}
const desktopSources = new Set(['dpkg_desktop', 'rpm_desktop', 'snap_desktop', 'flatpak_desktop', 'app_bundle_desktop', 'registry_desktop', 'appx_desktop'])
const linuxDesktopComponents = new Set([
  'cnrdrvcups-ufr2-uk', 'eog', 'evince', 'gnome-calculator', 'gnome-characters',
  'gnome-clocks', 'gnome-font-viewer', 'gnome-text-editor', 'info', 'nautilus',
  'seahorse', 'vim-common', 'yelp',
])

export function isDesktopApplication(app: { name: string; source?: string }): boolean {
  if (!desktopSources.has(app.source || '')) return false
  if (app.source === 'dpkg_desktop' || app.source === 'rpm_desktop') {
    const packageName = app.name.toLowerCase().replace(/:[a-z0-9_-]+$/, '')
    return !linuxDesktopComponents.has(packageName)
  }
  return true
}

export interface SoftwarePermissions { canInstall: boolean; canManageCatalog: boolean }
export interface SoftwareApproval { id: string; ticketNumber: string; applicationId: string; packageName: string; action: 'install' | 'remove'; approvedAt: string; requestId: string; available: boolean }
export interface SoftwareApprovals { items: SoftwareApproval[]; canApprove: boolean }
export interface VendorVersion { version: string; sourceUrl: string; checkedAt: string; status: 'available' | 'unavailable' }
export interface VendorVersions { items: Record<string, VendorVersion> }
export function vendorKey(name: string): string {
  const aliases: Record<string, string> = { 'google-chrome-stable': 'chrome', 'google chrome': 'chrome', 'firefox': 'firefox', 'mozilla firefox': 'firefox', 'netbird-ui': 'netbird', 'netbird': 'netbird', 'onlyoffice-desktopeditors': 'onlyoffice', 'onlyoffice': 'onlyoffice', 'pritunl-client-electron': 'pritunl', 'pritunl': 'pritunl', 'rustdesk': 'rustdesk' }
  return aliases[name.toLowerCase().replace(/:[a-z0-9_-]+$/, '')] || ''
}
export interface CatalogApplication { id: string; entityId: string; name: string; packageName: string; os: string; active: boolean; description?: string }
export interface CatalogPage { items: CatalogApplication[]; page: number; hasMore: boolean; capabilities: SoftwarePermissions }
export interface LiveServices { items: Array<{ name: string; running: boolean | null; enabled: boolean | null }>; status: string; capabilities: { canManage: boolean }; error?: string }
export interface ActionRecord {
  requestId: string; assetId: string; kind: 'software' | 'service' | 'script'; action: string
  applicationId?: string; serviceName?: string; applicationName?: string; packageName?: string
  scriptId?: string; scriptHash?: string; scriptName?: string; category?: string
  status: 'succeeded' | 'failed' | 'unknown'; outcomeCode: string; createdAt: string; updatedAt: string
}
export interface ActionHistory { items: ActionRecord[]; capabilities: { canManage?: boolean; canInstall?: boolean; canApply?: boolean } }
export interface InstallationScript { id: string; entityId: string; name: string; category: 'application' | 'service'; type: 'sh' | 'sls'; os: string; description: string; hash: string; body?: string }
export interface InstallationScriptPage { items: InstallationScript[]; page: number; hasMore: boolean; capabilities: { canApply: boolean } }
export type ActionChoice = { kind: 'software'; action: 'install' | 'remove'; application: CatalogApplication } | { kind: 'service'; action: 'start' | 'stop' | 'restart' | 'enable' | 'disable'; serviceName: string } | { kind: 'script'; action: 'apply'; script: InstallationScript }

export class EndpointApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}
export const message = (error: unknown) => error instanceof Error ? error.message : 'Request unavailable.'
const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

// randomUUID is secure-context-only; getRandomValues is also available on HTTP LANs.
export function secureUUID(): string {
  const source = globalThis.crypto
  if (typeof source?.randomUUID === 'function') return source.randomUUID()
  if (typeof source?.getRandomValues !== 'function') throw new Error('Secure UUID generation is unavailable.')
  const bytes = source.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function catalogInputError(name: string, packageName: string, description: string): string {
  if (!name.trim() || [...name.trim()].length > 150 || name.includes('\0')) return 'Application name is required and must be at most 150 characters.'
  // Same ASCII allowlist as saltstack.ValidPackageIdentifier; no trailing newline exception.
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/.test(packageName) || /[^A-Za-z0-9._+-]/.test(packageName)) return 'Package identifier must be 1–200 characters, start with a letter or digit, and contain only letters, digits, dots, underscores, pluses or hyphens.'
  if ([...description].length > 4000 || description.includes('\0')) return 'Description must be at most 4000 characters and contain no null characters.'
  return ''
}

export async function endpointRequest<T>(token: string, path: string, signal: AbortSignal, body?: object): Promise<T> {
  const current = () => {
    if (signal.aborted || !token || token !== getToken()) throw new DOMException('Scope changed', 'AbortError')
  }
  current()
  const response = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET', signal, cache: 'no-store', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  current()
  if (response.status === 401 || response.status === 403) throw new EndpointApiError(response.status === 401 ? 'Session expired. Sign in again.' : 'Access denied for this account and scope.', response.status)
  if (response.status === 404) throw new EndpointApiError('Endpoint or API unavailable (404).', 404)
  const data = await readJson<T & { error?: string }>(response)
  current()
  if (!response.ok) throw new EndpointApiError(data?.error || `Request failed (HTTP ${response.status}).`, response.status)
  if (!body) validateResource(path, data)
  return data
}

// Validate the fields consumed by controls before treating a read as authority.
// Missing capabilities must never enable a control or crash the page.
function validateResource(path: string, data: unknown) {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const strings = (value: unknown, keys: string[]) => object(value) && keys.every(key => typeof value[key] === 'string')
  const items = (value: unknown) => object(value) && Array.isArray(value.items)
  const capabilities = (value: unknown) => object(value) && object(value.capabilities)
  let valid = true
  if (path === '/devices') valid = Array.isArray(data) && data.every(row => strings(row, ['id', 'hostname']))
  else if (path.startsWith('/devices/')) {
    valid = strings(data, ['id', 'entityId']) && object(data) &&
      ['installedApps', 'services'].every(key => data[key] == null || (Array.isArray(data[key]) && data[key].every(row => strings(row, ['name']))))
  } else if (path === '/software/permissions') valid = object(data)
    else if (/\/software-approvals$/.test(path)) valid = items(data) && object(data) && typeof data.canApprove === 'boolean' && (data as unknown as SoftwareApprovals).items.every(row => strings(row, ['id', 'ticketNumber', 'applicationId', 'packageName', 'approvedAt', 'requestId']) && ['install', 'remove'].includes(row.action) && typeof row.available === 'boolean')
    else if (path.startsWith('/software/vendor-versions?')) valid = object(data) && object(data.items) && Object.values(data.items).every(row => strings(row, ['version', 'sourceUrl', 'checkedAt', 'status']))
  else if (path.startsWith('/software/catalog?')) valid = items(data) && capabilities(data) && (data as CatalogPage).items.every(row => strings(row, ['id', 'entityId', 'name', 'packageName', 'os']) && typeof row.active === 'boolean')
  else if (/\/installation-scripts\?/.test(path)) valid = items(data) && capabilities(data) && (data as InstallationScriptPage).items.every(validInstallationScript)
  else if (/\/installation-scripts\//.test(path)) valid = validInstallationScript(data) && strings(data, ['body']) && !!(data as InstallationScript).body?.trim()
  else if (/\/services$/.test(path)) valid = items(data) && capabilities(data) && ['success', 'partial', 'unavailable'].includes((data as LiveServices).status) && (data as LiveServices).items.every(row => strings(row, ['name']))
  else if (/\/(software-installs|management-actions|script-runs)(\?|$)/.test(path)) {
    valid = items(data) && capabilities(data)
    if (valid) {
      const assetId = decodeURIComponent(path.split('/')[2])
      for (const row of (data as ActionHistory).items) {
        if (path.includes('/script-runs')) normalizeScriptRecord(row, assetId)
        else normalizeRecord(row, assetId, path.includes('/software-installs'))
      }
    }
  }
  if (!valid) throw new Error('Invalid API response. Controls remain unavailable.')
}

export function useEndpointResource<T>(token: string, path: string | null, revision = 0) {
  const key = JSON.stringify([token, path, revision])
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key: '' })
  useEffect(() => {
    if (!path || !token) return
    const controller = new AbortController()
    const unsubscribe = subscribeAuth(() => { if (getToken() !== token) controller.abort() })
    void endpointRequest<T>(token, path, controller.signal).then(data => setState({ key, data })).catch(error => {
      if (!controller.signal.aborted && getToken() === token) setState({ key, error: message(error) })
    })
    return () => { controller.abort(); unsubscribe() }
  }, [token, path, key])
  return state.key === key && getToken() === token ? { ...state, loading: false } : { data: undefined, error: undefined, loading: !!path && !!token }
}

// Match the backend's fail-closed OS families; never infer Linux from an unknown OS.
export function packageOS(name = '') {
  const value = name.trim().toLowerCase()
  const families: Array<[string, string[]]> = [
    ['windows', ['windows', 'microsoft windows']], ['macos', ['macos', 'mac os', 'mac os x', 'darwin']],
    ['linux', ['linux', 'ubuntu', 'debian', 'rocky', 'almalinux', 'centos', 'red hat enterprise linux', 'rhel', 'fedora', 'arch linux', 'opensuse', 'suse linux enterprise', 'linux mint', 'oracle linux']],
  ]
  return families.find(([family, prefixes]) => prefixes.some(prefix => value === prefix || value.startsWith(`${prefix} `) || (family === 'linux' && value.startsWith(`${prefix}/`))))?.[0] || ''
}

export const journalKey = (accountId: string, entityId: string, assetId: string) => `itms-endpoint-requests:${JSON.stringify([accountId, entityId, assetId])}`
export function readJournal(key: string, assetId: string): ActionRecord[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) || '[]')
    if (!Array.isArray(value)) return []
    return value.filter((row): row is ActionRecord => row && row.assetId === assetId && typeof row.requestId === 'string' && /^[0-9a-f-]{36}$/i.test(row.requestId) && ['software', 'service', 'script'].includes(row.kind) && ['succeeded', 'failed', 'unknown'].includes(row.status))
  } catch { return [] }
}
export function mergeRecords(local: ActionRecord[], remote: ActionRecord[]) {
  const records = new Map(local.map(item => [recordKey(item), item]))
  remote.forEach(item => {
    const previous = records.get(recordKey(item))
    // Client reservation timestamps can be ahead of server time. An unknown
    // reservation must not hide a verified terminal outcome from either source.
    if (previous?.status !== 'unknown' && item.status === 'unknown' && previous) return
    records.set(recordKey(item), item)
  })
  return [...records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

// Backend install and management request UUIDs occupy separate namespaces.
export const recordKey = (record: ActionRecord) => `${record.kind === 'script' ? 'script' : record.action === 'install' ? 'install' : 'management'}:${record.requestId}`

function validInstallationScript(value: unknown): value is InstallationScript {
  if (!value || typeof value !== 'object') return false
  const script = value as InstallationScript
  return ['id', 'entityId', 'name', 'os', 'description', 'hash'].every(key => typeof script[key as keyof InstallationScript] === 'string') &&
    ['application', 'service'].includes(script.category) && ['sh', 'sls'].includes(script.type) && /^[0-9a-f]{64}$/.test(script.hash)
}

export function normalizeScriptRecord(record: ActionRecord, assetId: string): ActionRecord {
  return normalizeRecord({ ...record, kind: 'script', action: 'apply' }, assetId)
}

export function normalizeRecord(record: ActionRecord, assetId: string, install = false): ActionRecord {
  if (!record || record.assetId !== assetId || typeof record.requestId !== 'string' || !record.requestId || !['succeeded', 'failed', 'unknown'].includes(record.status) ||
    !['outcomeCode', 'createdAt', 'updatedAt'].every(key => typeof record[key as keyof ActionRecord] === 'string') ||
    (!install && !((record.kind === 'software' && record.action === 'remove' && typeof record.applicationId === 'string') ||
      (record.kind === 'service' && ['start', 'stop', 'restart', 'enable', 'disable'].includes(record.action) && typeof record.serviceName === 'string') ||
      (record.kind === 'script' && record.action === 'apply' && typeof record.scriptId === 'string' && typeof record.scriptName === 'string' && /^[0-9a-f]{64}$/.test(record.scriptHash || '') && ['application', 'service'].includes(record.category || ''))))) throw new Error('Invalid action outcome. Check status before any further action.')
  return install ? { ...record, kind: 'software', action: 'install' } : record
}