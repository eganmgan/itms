import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { computer, deferred, ids, json, options } from './fixtures.test-support'

vi.mock('../lib/portalAccess', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/portalAccess')>()
  return { ...actual, usePortalAccess: () => ({ access: { role: 'super_admin', sections: actual.portalSections, readOnly: false, customized: false }, loading: false }) }
})

vi.mock('../pages/DashboardView', () => ({ DashboardView: () => <h1>Dashboard fixture</h1> }))
vi.mock('../pages/DevicesPage', () => ({ DevicesPage: () => <h1>Devices fixture</h1> }))
vi.mock('../pages/DeviceOverviewPage', () => ({ DeviceOverviewPage: () => <h1>Device fixture</h1> }))
vi.mock('../pages/PatchPage', () => ({ PatchPage: () => <h1>Patch fixture</h1> }))
vi.mock('../pages/SecurityPage', () => ({ SecurityPage: () => <h1>Security fixture</h1> }))
vi.mock('../pages/EmployeePage', () => ({ EmployeePage: () => <h1>Employee fixture</h1> }))
vi.mock('../pages/GatepassPage', () => ({ GatepassPage: () => <h1>Gatepass fixture</h1> }))
vi.mock('../components/ChatAssistant', () => ({ ChatAssistant: () => null }))

let role: unknown
function api(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  if (url.endsWith('/auth/me')) return Promise.resolve(json({ id: ids.user, role }))
  if (url.includes('/admin/suppliers') || url.includes('/admin/scripts')) return Promise.resolve(json({ items: [], page: 1, hasMore: false, canWrite: ['admin', 'super_admin'].includes(String(role)) || url.includes('/admin/scripts') }))
  if (url.includes('/options')) return Promise.resolve(json(options))
  if (url.endsWith(`/assets/${ids.asset}`) || init?.method === 'POST') return Promise.resolve(json(computer))
  return Promise.resolve(json({ items: [computer], total: 1, page: 1, pageSize: 25 }))
}
function account(token: string | null, storage = false) {
  act(() => {
    if (token) localStorage.setItem('itms_token', token)
    else localStorage.removeItem('itms_token')
    window.dispatchEvent(storage ? new StorageEvent('storage', { key: 'itms_token' }) : new Event('itms-auth-changed'))
  })
}
const assetCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/admin/assets'))
const nav = () => within(screen.getByRole('navigation'))
function direct(path: string) {
  act(() => { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')) })
}
function assertAdminNavigation(superAdmin: boolean) {
  for (const name of ['Admin computers', 'Suppliers', 'Installation scripts', 'Manual Entry']) expect(nav().queryByRole('button', { name })).not.toBeInTheDocument()
  if (superAdmin) {
    expect(nav().getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Back to Settings' })).toHaveAttribute('href', '/settings')
  } else {
    expect(nav().queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Back to Settings' })).not.toBeInTheDocument()
  }
}

describe('admin route authorization and account isolation', () => {
  beforeEach(() => { role = 'admin'; localStorage.clear(); localStorage.setItem('itms_token', 'first-account'); window.history.replaceState({}, '', '/admin/assets'); vi.stubGlobal('fetch', vi.fn(api)) })
  afterEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/'); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it.each(['admin', 'super_admin'])('navigates suppliers and storage scripts for %s with browser history', async value => {
    role = value
    render(<App />)
    await screen.findByText(computer.name)
    assertAdminNavigation(['admin', 'super_admin'].includes(value))
    direct('/admin/suppliers')
    expect(window.location.pathname).toBe('/admin/suppliers')
    await screen.findByRole('heading', { name: 'Supplier administration' })
    await screen.findByText('No records found.')
    expect(!!screen.queryByRole('button', { name: 'Add supplier' })).toBe(['admin', 'super_admin'].includes(value))
    assertAdminNavigation(['admin', 'super_admin'].includes(value))
    direct('/admin/scripts')
    expect(window.location.pathname).toBe('/admin/scripts')
    expect(await screen.findByRole('button', { name: 'Add installation script' })).toBeVisible()
    assertAdminNavigation(['admin', 'super_admin'].includes(value))
    act(() => window.history.back())
    await waitFor(() => expect(window.location.pathname).toBe('/admin/suppliers'))
    expect(await screen.findByRole('heading', { name: 'Supplier administration' })).toBeVisible()
    act(() => window.history.forward())
    await waitFor(() => expect(window.location.pathname).toBe('/admin/scripts'))
    expect(await screen.findByRole('heading', { name: 'Application & service installation scripts' })).toBeVisible()
  })

  it.each(['/admin/suppliers', '/admin/scripts'])('enforces exact roles, pending auth, and stale auth on %s', async path => {
    window.history.replaceState({}, '', path)
    const pending = deferred<Response>()
    vi.mocked(fetch).mockImplementation(() => pending.promise.then(response => response.clone()))
    render(<App />)
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/auth/me'))).toHaveLength(2)
    expect(screen.getByRole('status')).toHaveTextContent('Checking administrator access')
    role = 'it_team'
    vi.mocked(fetch).mockImplementation(api)
    account('second-account', true)
    expect(await screen.findByRole('alert')).toHaveTextContent('Only admin and super_admin')
    await act(async () => pending.resolve(json({ role: 'super_admin' })))
    expect(nav().queryByRole('button', { name: 'Suppliers' })).not.toBeInTheDocument()
    expect(nav().queryByRole('button', { name: 'Installation scripts' })).not.toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).endsWith('/auth/me'))).toBe(true)
  })

  it.each(['/admin/suppliers', '/admin/scripts'])('requires sign-in on direct %s without requesting data', path => {
    localStorage.clear(); window.history.replaceState({}, '', path); render(<App />)
    expect(screen.getByRole('heading', { name: 'Sign-in required' })).toBeVisible()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['employee', 'auditor', 'it_team', 'operator', 'Admin', 'SUPER_ADMIN', ' admin', null])('denies catalog navigation and direct pages for role %j', async value => {
    role = value; window.history.replaceState({}, '', '/admin/scripts'); render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Only admin and super_admin')
    act(() => { window.history.pushState({}, '', '/admin/suppliers'); window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(screen.getByRole('alert')).toHaveTextContent('Only admin and super_admin')
    expect(nav().queryByRole('button', { name: 'Suppliers' })).not.toBeInTheDocument()
    expect(nav().queryByRole('button', { name: 'Installation scripts' })).not.toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).endsWith('/auth/me'))).toBe(true)
  })

  it.each(['admin', 'super_admin'])('preserves direct computer access for verified %s without removed navigation', async value => {
    role = value
    render(<App />)
    expect(nav().queryByRole('button', { name: 'Admin computers' })).not.toBeInTheDocument()
    expect(await screen.findByText('Manual workstation')).toBeVisible()
    expect(window.location.pathname).toBe('/admin/assets')
    assertAdminNavigation(['admin', 'super_admin'].includes(value))
    expect(fetch).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({ headers: { Authorization: 'Bearer first-account' } }))
  })
  it.each(['admin', 'super_admin'].flatMap(value => ['/admin/assets', '/admin/assets/', '/admin-assets', '/admin/computers', '/admin/assets?entity=ignored'].map(path => [value, path])))('opens authorized %s route or alias %s', async (value, path) => {
    role = value
    window.history.replaceState({}, '', path); render(<App />)
    expect(await screen.findByText('Manual workstation')).toBeVisible()
    assertAdminNavigation(['admin', 'super_admin'].includes(value))
  })
  it.each([
    ['Computers', '/admin/assets', 'Manual computers', 'Create computer'],
    ['Suppliers', '/admin/suppliers', 'Supplier administration', 'Add supplier'],
    ['Installation scripts', '/admin/scripts', 'Application & service installation scripts', 'Add installation script'],
  ])('opens the existing %s workflow from Settings and returns without a reload', async (name, path, heading, action) => {
    role = 'super_admin'; window.history.replaceState({}, '', '/settings'); render(<App />)
    const link = await screen.findByRole('link', { name: new RegExp(`^${name}`) })
    expect(link).toHaveAttribute('href', path)
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).endsWith('/auth/me'))).toBe(true)
    fireEvent.click(link)
    expect(window.location.pathname).toBe(path)
    await screen.findByRole('heading', { name: heading })
    await waitFor(() => expect(screen.getByRole('button', { name: action })).toBeEnabled())
    assertAdminNavigation(true)
    const back = screen.getByRole('link', { name: 'Back to Settings' })
    expect(back.compareDocumentPosition(screen.getByRole('heading', { name: heading })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(back)
    expect(window.location.pathname).toBe('/settings')
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Back to Settings' })).not.toBeInTheDocument()
    act(() => window.history.back())
    await waitFor(() => expect(window.location.pathname).toBe(path))
    await screen.findByRole('heading', { name: heading })
    assertAdminNavigation(true)
  })
  it.each(['it_team', 'employee', 'auditor', 'administrator', 'Admin', ' super_admin', '', null])('denies role %j with no asset or options request', async value => {
    role = value; render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Only admin and super_admin')
    expect(nav().queryByRole('button', { name: 'Admin computers' })).not.toBeInTheDocument()
    expect(assetCalls()).toHaveLength(0)
    expect(screen.queryByText(computer.name)).not.toBeInTheDocument()
  })
  it.each(['/admin-assets', '/admin/computers'])('aliases do not bypass role checks at %s', async path => {
    role = 'it_team'; window.history.replaceState({}, '', path); render(<App />)
    await screen.findByRole('alert'); expect(assetCalls()).toHaveLength(0)
  })
  it('requires sign-in without any API call and preserves standalone login', () => {
    localStorage.clear(); render(<App />)
    expect(screen.getByRole('heading', { name: 'Sign-in required' })).toBeVisible()
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Sign in' }))
    expect(window.location.pathname).toBe('/login')
    expect(screen.getByRole('heading', { name: 'Welcome to ITMS' })).toBeVisible()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['network', 'nonJSON', '401', '403', '500'])('fails closed when auth/me returns %s', async failure => {
    vi.mocked(fetch).mockImplementation(async () => {
      if (failure === 'network') throw new Error('Network failure')
      return failure === 'nonJSON' ? new Response('<html>internal details</html>') : json({ error: 'private auth error', role: 'admin' }, Number(failure))
    })
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to verify administrator access')
    expect(screen.queryByText(/private auth error|internal details/)).not.toBeInTheDocument()
    expect(assetCalls()).toHaveLength(0)
    expect(nav().queryByRole('button', { name: 'Admin computers' })).not.toBeInTheDocument()
    vi.mocked(fetch).mockImplementation(api)
    fireEvent.click(screen.getByRole('button', { name: 'Check access again' }))
    expect(await screen.findByText(computer.name)).toBeVisible()
  })
  it.each([401, 403])('clears authorized page and hides nav on asset HTTP %s without rendering response data', async status => {
    vi.mocked(fetch).mockImplementation((url, init) => String(url).includes('/admin/assets') ? Promise.resolve(json({ error: 'secret denied record', items: [computer] }, status)) : api(url, init))
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Computer administration unavailable' })).toBeVisible()
    expect(screen.queryByText(/secret denied record|Manual workstation/)).not.toBeInTheDocument()
    expect(nav().queryByRole('button', { name: 'Admin computers' })).not.toBeInTheDocument()
  })
  it('never starts asset requests while auth is pending and ignores late admin identity after logout', async () => {
    const pending = deferred<Response>()
    vi.mocked(fetch).mockImplementation(() => pending.promise)
    render(<App />)
    expect(screen.getByRole('status')).toHaveTextContent('Checking administrator access')
    expect(assetCalls()).toHaveLength(0)
    account(null)
    await act(async () => pending.resolve(json({ role: 'admin' })))
    expect(screen.getByRole('heading', { name: 'Welcome to ITMS' })).toBeVisible()
    expect(window.location.pathname).toBe('/login')
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(assetCalls()).toHaveLength(0)
  })
  it('ignores old admin identity after switching to an employee account', async () => {
    const pending = deferred<Response>()
    vi.mocked(fetch).mockImplementation((_url, init) => (init?.headers as Record<string, string>)?.Authorization === 'Bearer first-account' ? pending.promise : Promise.resolve(json({ role: 'employee' })))
    render(<App />); account('second-account', true)
    await screen.findByRole('alert')
    await act(async () => pending.resolve(json({ role: 'super_admin' })))
    expect(nav().queryByRole('button', { name: 'Admin computers' })).not.toBeInTheDocument()
    expect(assetCalls()).toHaveLength(0)
  })
  it('clears existing data on account switch and ignores the old account list response', async () => {
    render(<App />)
    await screen.findByText(computer.name)
    const pending = deferred<Response>()
    vi.mocked(fetch).mockImplementation((url, init) => String(url).includes('/assets?') ? pending.promise : api(url, init))
    fireEvent.change(screen.getByLabelText('Rows per page'), { target: { value: '50' } })
    role = 'employee'; account('second-account', true)
    await screen.findByRole('alert')
    await act(async () => pending.resolve(json({ items: [{ ...computer, name: 'Old private computer' }], total: 1, page: 1, pageSize: 50 })))
    expect(screen.queryByText(/Old private computer|Manual workstation/)).not.toBeInTheDocument()
    expect(nav().queryByRole('button', { name: 'Admin computers' })).not.toBeInTheDocument()
  })
  it('revokes access after a denied write without leaking its error body or retrying', async () => {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Details for PC-001' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit computer' }))
    await waitFor(() => expect(screen.getByLabelText('Location')).toBeEnabled())
    vi.mocked(fetch).mockImplementation((url, init) => init?.method === 'PATCH' ? Promise.resolve(json({ error: 'Private mutation details' }, 403)) : api(url, init))
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Do not retain this form' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByRole('heading', { name: 'Computer administration unavailable' })
    expect(screen.queryByText(/Private mutation details|Do not retain this form/)).not.toBeInTheDocument()
    expect(nav().queryByRole('button', { name: 'Admin computers' })).not.toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1)
  })
  it.each(['list', 'options', 'detail', 'write'])('aborts and ignores stale %s responses after logout even if transport resolves', async target => {
    const pending = deferred<Response>()
    let heldSignal: AbortSignal | null | undefined
    let enabled = target === 'list' || target === 'options'
    vi.mocked(fetch).mockImplementation((url, init) => {
      const path = String(url)
      const hold = enabled && (target === 'list' ? path.includes('/assets?') : target === 'options' ? path.includes('/options') : target === 'detail' ? path.endsWith(`/assets/${ids.asset}`) : init?.method === 'PATCH')
      if (hold) { heldSignal = init?.signal; return pending.promise }
      return api(url, init)
    })
    render(<App />)
    await screen.findByRole('heading', { name: 'Manual computers' })
    if (target === 'detail' || target === 'write') {
      await screen.findByRole('button', { name: 'Details for PC-001' })
      await waitFor(() => expect(screen.getByRole('button', { name: 'Create computer' })).toBeEnabled())
      enabled = target === 'detail'
      fireEvent.click(screen.getByRole('button', { name: 'Details for PC-001' }))
      if (target === 'write') {
        fireEvent.click(await screen.findByRole('button', { name: 'Edit computer' }))
        await waitFor(() => expect(screen.getByLabelText('Location')).toBeEnabled())
        fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Late mutation' } })
        enabled = true; fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
      }
    }
    await waitFor(() => expect(heldSignal).toBeDefined())
    account(null)
    expect(heldSignal?.aborted).toBe(true)
    const callsAtLogout = vi.mocked(fetch).mock.calls.length
    await act(async () => pending.resolve(json(target === 'options' ? options : target === 'list' ? { items: [computer], total: 1, page: 1, pageSize: 25 } : { ...computer, name: 'Late mutation' })))
    expect(screen.getByRole('heading', { name: 'Welcome to ITMS' })).toBeVisible()
    expect(window.location.pathname).toBe('/login')
    expect(screen.queryByText(/Manual workstation|Late mutation/)).not.toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls).toHaveLength(callsAtLogout)
  })
})