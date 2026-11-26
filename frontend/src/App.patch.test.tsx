import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

// Keep the actual shell, auth hooks, Patch page and app controls integrated.
vi.mock('./components/ChatAssistant', () => ({ ChatAssistant: () => null }))
vi.mock('./components/SSHTerminal', () => ({ SSHTerminal: () => null }))
vi.mock('./pages/DashboardView', () => ({ DashboardView: () => <h1>Dashboard fixture</h1> }))

const assetId = '11111111-1111-4111-8111-111111111111'
const deviceRoute = `/devices/${assetId}`
const route = `${deviceRoute}/apps`
const entityId = '22222222-2222-4222-8222-222222222222'
const applicationId = '33333333-3333-4333-8333-333333333333'
const requestId = '44444444-4444-4444-8444-444444444444'
const device = { id: assetId, entityId, hostname: 'authorized-system', assetTag: 'FIX-1', osName: 'Ubuntu 24.04', installedApps: [{ name: 'approved-app', source: 'dpkg_desktop' }] }
const capabilities = { canInstall: true, canManage: true, canManageCatalog: false }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

function setup(role = 'it_team', unavailable = false) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (init?.method === 'POST') throw new Error('Fixture lost response')
    if (path === '/api/me/portal-access') return json({ role, sections: ['devices', 'patch', 'security', 'employee', 'gatepass'], readOnly: role === 'auditor', customized: false })
    if (path === '/api/auth/me') return json({ id: localStorage.getItem('itms_token'), role })
    if (path === '/api/devices') return json([device])
    if (path === `/api/devices/${assetId}`) return json(device)
    if (path.startsWith(`/api/devices/${assetId}/connectivity`)) return json({ connected: null, connectivitySource: 'salt_unconfigured', connectivityCheckedAt: null })
    if (path === '/api/departments') return json([])
    if (path.startsWith('/api/software/') || path.startsWith('/api/assets/')) {
      if (unavailable) return json({ error: 'API not released' }, 404)
      if (path === '/api/software/permissions') return json(capabilities)
      if (path.endsWith('/software-approvals')) return json({ items: ['install', 'remove'].map(action => ({ id: action === 'install' ? requestId : assetId, ticketNumber: 'TKT-001', applicationId, packageName: 'approved-app', action, approvedAt: '2026-09-30T01:00:00Z', requestId: '', available: true })), canApprove: false })
      if (path.startsWith('/api/software/vendor-versions?')) return json({ items: {} })
      if (path.startsWith('/api/software/catalog?')) return json({ items: [{ id: applicationId, entityId, name: 'Approved app', packageName: 'approved-app', os: 'linux', active: true }], page: 1, hasMore: false, capabilities })
      return json({ items: [], capabilities, status: 'success' })
    }
    if (path === '/api/patch/dashboard') return json({ total: 0, upToDate: 0, pending: 0, failed: 0, rebootPending: 0 })
    if (path === '/api/patch/devices') return json([])
    throw new Error(`Unexpected fixture request: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
const primary = () => within(screen.getByRole('navigation', { name: 'Primary navigation' }))
const writes = (mock: ReturnType<typeof setup>) => mock.mock.calls.filter(([, init]) => init?.method === 'POST')
async function selectDevice() {
  await screen.findByRole('region', { name: 'Approved applications' })
  expect(screen.queryByLabelText('Device')).not.toBeInTheDocument()
}
async function selectPackage() {
  await screen.findByRole('option', { name: /Approved app/ })
  fireEvent.change(screen.getByLabelText('Approved package'), { target: { value: applicationId } })
}
async function history(direction: 'back' | 'forward', path: string) {
  act(() => window.history[direction]())
  await waitFor(() => expect(window.location.pathname).toBe(path))
}

describe('Device app install navigation integration', () => {
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear()
    localStorage.setItem('itms_token', 'fixture-operator')
    window.history.replaceState({}, '', route)
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(requestId)
  })
  afterEach(() => {
    vi.unstubAllGlobals(); vi.restoreAllMocks()
    localStorage.clear(); sessionStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  it('opens from device tabs and keeps URL and page aligned through back/forward', async () => {
    const fetchMock = setup()
    window.history.replaceState({}, '', deviceRoute)
    render(<App />)
    const tab = await screen.findByRole('tab', { name: 'Apps' })
    fireEvent.click(tab)
    expect(window.location.pathname).toBe(route)
    expect(await screen.findByRole('tab', { name: 'Apps' })).toHaveAttribute('aria-selected', 'true')
    expect(primary().getByRole('button', { name: 'Devices' })).toHaveAttribute('aria-current', 'page')
    await selectDevice(); await selectPackage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review install' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Review install' }))
    expect(screen.getByRole('dialog', { name: 'Confirm endpoint action' })).toHaveTextContent('approved-app')
    await history('back', deviceRoute)
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await history('forward', route)
    await selectDevice()
    expect(screen.getByRole('tab', { name: 'Apps' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab', { name: 'Apps & Services' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Approved package')).toHaveValue('')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(writes(fetchMock)).toHaveLength(0)
  })

  it.each([route, `${route}/`, `${route}?source=bookmark`, `${deviceRoute}/applications`])('opens direct link %s without console requests or command inputs', async path => {
    const fetchMock = setup()
    window.history.replaceState({}, '', path)
    render(<App />)
    await selectDevice(); await selectPackage()
    expect(screen.getByRole('heading', { name: 'authorized-system', level: 1 })).toBeVisible()
    expect(screen.getAllByRole('tab', { name: 'Apps' })).toHaveLength(1)
    expect(screen.getByRole('tab', { name: 'Apps' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('tab', { name: 'Applications' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Patch execution controls' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/patch/'))).toBe(false)
    expect(fetchMock.mock.calls.every(([, init]) => new Headers(init?.headers).get('Authorization') === 'Bearer fixture-operator')).toBe(true)
    expect(writes(fetchMock)).toHaveLength(0)
  })

  it.each(['/patch/apps', '/patch/apps-services'])('retires %s without loading fleet controls or Patch APIs', async path => {
    const fetchMock = setup()
    window.history.replaceState({}, '', path)
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Apps moved to Devices' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Open Devices' })).toHaveAttribute('href', '/devices')
    expect(fetchMock.mock.calls.every(([url]) => url === '/api/auth/me')).toBe(true)
  })

  it('guards signed-out device bookmarks without requesting data', () => {
    const fetchMock = setup()
    localStorage.clear()
    render(<App />)
    expect(window.location.pathname).toBe(route)
    expect(screen.getByRole('heading', { name: 'Sign-in required' })).toBeVisible()
    expect(screen.queryByLabelText('Device')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['employee', 'unknown'])('denies %s direct-route inventory access', async role => {
    const fetchMock = setup(role)
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('does not have inventory management read access')
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/software/') || String(url).startsWith('/api/assets/'))).toBe(false)
    expect(screen.queryByLabelText('Device')).not.toBeInTheDocument()
  })

  it.each(['admin', 'auditor'])('keeps %s scoped readers read-only despite optimistic capability fixtures', async role => {
    const fetchMock = setup(role)
    render(<App />)
    await selectDevice(); await selectPackage()
    expect(screen.getByText(/Read-only access/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Review install' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Review remove' })).toBeDisabled()
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/patch/'))).toBe(false)
    expect(writes(fetchMock)).toHaveLength(0)
  })

  it('clears selections and pending confirmation on account switch and sign-out', async () => {
    const fetchMock = setup()
    render(<App />)
    await selectDevice(); await selectPackage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review remove' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Review remove' }))
    expect(screen.getByRole('dialog')).toBeVisible()
    act(() => { localStorage.setItem('itms_token', 'fixture-other-operator'); window.dispatchEvent(new Event('itms-auth-changed')) })
    await selectDevice()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Approved package')).toHaveValue('')
    act(() => { localStorage.removeItem('itms_token'); window.dispatchEvent(new StorageEvent('storage', { key: 'itms_token' })) })
    expect(screen.getByRole('heading', { name: 'Welcome to ITMS' })).toBeVisible()
    expect(window.location.pathname).toBe('/login')
    expect(screen.queryByLabelText('Device')).not.toBeInTheDocument()
    expect(writes(fetchMock)).toHaveLength(0)
  })

  it('retains unknown outcome across navigation and never retries the mutation', async () => {
    const fetchMock = setup()
    render(<App />)
    await selectDevice(); await selectPackage()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review install' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Review install' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    await screen.findByText(/Outcome unknown. Request ID retained/)
    fireEvent.click(primary().getByRole('button', { name: 'Patch' }))
    await screen.findByRole('heading', { name: 'Salt patch engine' })
    await history('back', route)
    await selectDevice(); await selectPackage()
    expect(screen.getByText('unknown')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Review install' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: `Check status ${requestId}` }))
    await screen.findByText(/No durable result found/)
    expect(writes(fetchMock)).toHaveLength(1)
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1)
  })

  it('shows API errors and fails closed when the APIs return 404', async () => {
    const fetchMock = setup('it_team', true)
    render(<App />)
    await selectDevice()
    await screen.findByText(/Catalog unavailable/)
    expect(screen.queryByText(/Requires the coordinated Apps & Services backend/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review install' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Review remove' })).toBeDisabled()
    expect(writes(fetchMock)).toHaveLength(0)
  })
})