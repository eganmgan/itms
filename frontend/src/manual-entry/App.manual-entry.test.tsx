import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'

vi.mock('../lib/portalAccess', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/portalAccess')>()
  return { ...actual, usePortalAccess: () => ({ access: { role: 'super_admin', sections: actual.portalSections, readOnly: false, customized: false }, loading: false }) }
})
import { api, deferred, employee, json } from './fixtures.test-support'

vi.mock('../components/ChatAssistant', () => ({ ChatAssistant: () => null }))
vi.mock('../pages/DevicesPage', () => ({ DevicesPage: () => <h1>Devices fixture</h1> }))
vi.mock('../pages/DashboardView', () => ({ DashboardView: () => <h1>Dashboard fixture</h1> }))
let role: unknown
function fetcher(input: RequestInfo | URL, init?: RequestInit) {
  return String(input).endsWith('/auth/me') ? Promise.resolve(json({ role })) : api(input, init)
}
const nav = () => within(screen.getByRole('navigation', { name: 'Primary navigation' }))
const dataCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => !String(url).endsWith('/auth/me'))
const settingsPaths = ['/settings', '/settings/employees', '/admin/manual-entry', '/admin/manual-entry/employees']
function assertPrimaryNav() {
  for (const name of ['Admin computers', 'Suppliers', 'Installation scripts', 'Manual Entry']) expect(nav().queryByRole('button', { name })).not.toBeInTheDocument()
}
function account(value: string | null) {
  act(() => {
    if (value) localStorage.setItem('itms_token', value)
    else localStorage.removeItem('itms_token')
    window.dispatchEvent(new Event('itms-auth-changed'))
  })
}

describe('Settings verified role boundaries', () => {
  beforeEach(() => { role = 'super_admin'; localStorage.clear(); localStorage.setItem('itms_token', 'first-account'); window.history.replaceState({}, '', '/settings'); vi.stubGlobal('fetch', vi.fn(fetcher)) })
  afterEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/'); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it.each(settingsPaths)('requires sign-in on direct %s with no requests', path => {
    localStorage.clear(); window.history.replaceState({}, '', path); render(<App />)
    expect(screen.getByRole('heading', { name: 'Sign-in required' })).toBeVisible(); expect(fetch).not.toHaveBeenCalled()
    expect(nav().queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
    assertPrimaryNav()
  })

  it.each(['Admin', 'it_team', 'employee', 'auditor', 'operator', 'SUPER_ADMIN', ' super_admin', '', null])('denies exact role %j on all canonical and alias routes without any data request', async value => {
    role = value; render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Only verified admin or super_admin')
    for (const path of settingsPaths) {
      act(() => { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')) })
      expect(screen.getByRole('heading', { name: 'Settings unavailable' })).toBeVisible()
      expect(screen.getByRole('alert')).toHaveTextContent('Only verified admin or super_admin accounts may use Settings.')
      expect(nav().queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Back to Settings' })).not.toBeInTheDocument()
      assertPrimaryNav()
    }
    expect(dataCalls()).toHaveLength(0)
  })

  it.each(['admin', 'super_admin'].flatMap(role => [...settingsPaths, '/settings/', '/settings/employees/'].map(path => ({ role, path }))))('opens $path after verified $role access and uses canonical links', async ({ role: accountRole, path }) => {
    role = accountRole
    window.history.replaceState({}, '', path); render(<App />)
    expect(nav().queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
    expect(dataCalls()).toHaveLength(0)
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Settings' })).toBeVisible()
    expect(nav().getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
    assertPrimaryNav()
    if (path.includes('/employees')) {
      await screen.findByRole('heading', { name: 'Add employee' })
      fireEvent.click(screen.getByRole('button', { name: 'All settings' }))
      expect(window.location.pathname).toBe('/settings')
    } else expect(dataCalls()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /Employee addition/ }))
    expect(window.location.pathname).toBe('/settings/employees')
    expect(await screen.findByRole('heading', { name: 'Add employee' })).toBeVisible()
  })

  it('shows the verified administrator nav, canonical employee path and browser history', async () => {
    window.history.replaceState({}, '', '/devices'); render(<App />)
    expect(nav().queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
    fireEvent.click(await nav().findByRole('button', { name: 'Settings' }))
    expect(window.location.pathname).toBe('/settings')
    await screen.findByRole('heading', { name: 'Settings' })
    expect(nav().getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
    assertPrimaryNav()
    expect(dataCalls()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /Employee addition/ }))
    expect(window.location.pathname).toBe('/settings/employees')
    await screen.findByRole('heading', { name: 'Add employee' })
    expect(nav().getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
    act(() => window.history.back()); await waitFor(() => expect(window.location.pathname).toBe('/settings'))
    await screen.findByRole('button', { name: /Employee addition/ })
    act(() => window.history.forward()); await waitFor(() => expect(window.location.pathname).toBe('/settings/employees'))
    expect(await screen.findByRole('heading', { name: 'Add employee' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'All settings' }))
    expect(window.location.pathname).toBe('/settings')
    expect(await screen.findByRole('button', { name: /Employee addition/ })).toBeVisible()
  })

  it.each(settingsPaths)('starts no data on %s while verification is pending and ignores late verification after account switch', async path => {
    const pending = deferred<Response>(); let signal: AbortSignal | null | undefined
    vi.mocked(fetch).mockImplementation((_url, init) => { signal = init?.signal; return pending.promise })
    window.history.replaceState({}, '', path); render(<App />)
    expect(screen.getByRole('status')).toHaveTextContent('Checking administrator access')
    expect(dataCalls()).toHaveLength(0)
    role = 'employee'; vi.mocked(fetch).mockImplementation(fetcher); account('second-account')
    expect(signal?.aborted).toBe(true)
    await screen.findByRole('alert'); await act(async () => pending.resolve(json({ role: 'super_admin' })))
    expect(nav().queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument(); expect(dataCalls()).toHaveLength(0)
  })

  it.each(settingsPaths.flatMap(path => [401, 403, 500, 'network', 'malformed'].map(status => ({ path, status }))))('fails closed on auth $status at $path and can explicitly reverify', async ({ path, status }) => {
    window.history.replaceState({}, '', path)
    vi.mocked(fetch).mockImplementation(async () => {
      if (status === 'network') throw new Error('private transport details')
      return status === 'malformed' ? new Response('<html>private proxy details</html>') : json({ role: 'super_admin', error: 'private error' }, Number(status))
    })
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to verify')
    expect(nav().queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
    expect(dataCalls()).toHaveLength(0); expect(document.body.textContent).not.toContain('private')
    vi.mocked(fetch).mockImplementation(fetcher); fireEvent.click(screen.getByRole('button', { name: 'Check access again' }))
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible()
    expect(nav().getByRole('button', { name: 'Settings' })).toBeVisible()
  })

  it.each(['/settings/employees', '/admin/manual-entry/employees'].flatMap(path => [401, 403].map(status => ({ path, status }))))('revokes super-admin flag and nav when a section GET returns $status at $path', async ({ path, status }) => {
    vi.mocked(fetch).mockImplementation((url, init) => String(url).endsWith('/entities') ? Promise.resolve(json({ error: 'private denied body' }, status)) : fetcher(url, init))
    window.history.replaceState({}, '', path); render(<App />)
    expect(await screen.findByRole('heading', { name: 'Settings unavailable' })).toBeVisible()
    expect(nav().queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Initial password *')).not.toBeInTheDocument(); expect(document.body.textContent).not.toContain('private denied body')
  })

  it('aborts late search data after logout without leaking old account results', async () => {
    window.history.replaceState({}, '', '/admin/manual-entry/employees'); render(<App />)
    await screen.findByRole('heading', { name: 'Add employee' })
    const pending = deferred<Response>(); let signal: AbortSignal | null | undefined
    vi.mocked(fetch).mockImplementation((url, init) => String(url).includes('/users?') ? (signal = init?.signal, pending.promise) : fetcher(url, init))
    fireEvent.click(screen.getByRole('button', { name: 'Search employees' }))
    await waitFor(() => expect(signal).toBeDefined())
    account(null); expect(signal?.aborted).toBe(true)
    const count = vi.mocked(fetch).mock.calls.length
    await act(async () => pending.resolve(json({ items: [employee], total: 1, page: 1, pageSize: 25 })))
    expect(screen.getByRole('heading', { name: 'Welcome to ITMS' })).toBeVisible()
    expect(window.location.pathname).toBe('/login')
    expect(screen.queryByText(employee.email)).not.toBeInTheDocument(); expect(vi.mocked(fetch).mock.calls).toHaveLength(count)
  })
})