import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { DirectoryUser } from './pages/DevicesPage'
import { idleLogoutMs, saveSession } from './lib/auth'
import { portalSections } from './lib/portalAccess'

vi.mock('./pages/DashboardView', () => ({ DashboardView: () => <h1>Dashboard fixture</h1> }))
vi.mock('./pages/DeviceOverviewPage', () => ({ DeviceOverviewPage: ({ device }: { device: DirectoryUser }) => <h1>Endpoint {device.fullName} {device.primaryAssetId}</h1> }))
vi.mock('./pages/EmployeePage', () => ({ EmployeePage: ({ dashboard }: { dashboard?: boolean }) => <h1>{dashboard ? 'Personal dashboard fixture' : 'Employee fixture'}</h1> }))
vi.mock('./pages/GatepassPage', () => ({ GatepassPage: () => <h1>Gatepass fixture</h1> }))
vi.mock('./pages/PatchPage', () => ({ PatchPage: () => <h1>Patch fixture</h1> }))
vi.mock('./pages/SecurityPage', () => ({ SecurityPage: () => <h1>Security fixture</h1> }))

const owner: DirectoryUser = { id: 'owner', fullName: 'Inventory fixture owner', email: 'owner@example.test', employeeCode: 'Z1042', departmentName: 'IT', branchName: 'HQ', assetCount: 2, newAssetCount: 0, ungroupedAssetCount: 0, flaggedAssetCount: 0, status: 'online', primaryAssetId: 'physical-thinkpad' }
const directory = { summary: { all: 2, new: 0, ungrouped: 0, flagged: 0 }, capabilities: { addDevice: false, installAgent: false }, departments: [], branches: [], users: [owner] }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
let fixtureRole = 'super_admin'
const defaultFetch = async (input: RequestInfo | URL) => json(String(input).endsWith('/me/portal-access') ? { role: fixtureRole, sections: portalSections, readOnly: fixtureRole === 'auditor', customized: false } : String(input).endsWith('/auth/me') ? { role: fixtureRole, full_name: 'Z1042' } : directory)
const nav = (label: string) => within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: label })
function submitLogin() {
  fireEvent.change(screen.getByLabelText(/employee id/i), { target: { value: 'Z1042' } })
  fireEvent.change(screen.getByLabelText(/^Password$/), { target: { value: 'FixturePassword!' } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
}
function auth(token: string | null, storage = false) {
  act(() => {
    if (token) localStorage.setItem('itms_token', token)
    else localStorage.removeItem('itms_token')
    window.dispatchEvent(storage ? new StorageEvent('storage', { key: 'itms_token' }) : new Event('itms-auth-changed'))
  })
}
async function history(direction: 'back' | 'forward', path: string) {
  act(() => window.history[direction]())
  await waitFor(() => expect(window.location.pathname).toBe(path))
}

describe('App login and navigation', () => {
  beforeEach(() => { localStorage.clear(); fixtureRole = 'super_admin'; vi.stubGlobal('fetch', vi.fn().mockImplementation(defaultFetch)); Element.prototype.scrollIntoView = vi.fn() })
  afterEach(() => { window.history.replaceState({}, '', '/'); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it.each([
    { role: 'employee', sections: ['devices', 'security', 'employee'], readOnly: false },
    { role: 'it_team', sections: [...portalSections], readOnly: false },
    { role: 'auditor', sections: [...portalSections], readOnly: true },
    { role: 'employee', sections: ['patch'], readOnly: false },
  ])('limits $role navigation to verified sections $sections', async access => {
    fixtureRole = access.role
    localStorage.setItem('itms_token', 'fixture-session')
    window.history.replaceState({}, '', '/dashboard')
    vi.mocked(fetch).mockImplementation(async input => String(input).endsWith('/me/portal-access') ? json({ ...access, customized: true }) : defaultFetch(input))
    render(<App />)
    const hasDashboard = access.role === 'employee' && access.sections.includes('employee')
    await waitFor(() => expect(window.location.pathname).toBe(hasDashboard ? '/dashboard' : `/${access.sections[0]}`))
    if (hasDashboard) await screen.findByRole('heading', { name: 'Personal dashboard fixture' })
    const navigation = within(screen.getByRole('navigation', { name: 'Primary navigation' }))
    for (const section of portalSections) {
      const button = navigation.queryByRole('button', { name: section[0].toUpperCase() + section.slice(1) })
      if (access.sections.includes(section)) expect(button).toBeVisible()
      else expect(button).not.toBeInTheDocument()
    }
    expect(navigation.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
    if (access.readOnly) {
      expect(screen.getByText('Auditor portal: read-only')).toBeVisible()
      expect(screen.queryByRole('button', { name: 'Open ITMS assistant' })).not.toBeInTheDocument()
    }
  })

  it('opens the personal dashboard from ITMS and keeps Employee separate', async () => {
    fixtureRole = 'employee'
    localStorage.setItem('itms_token', 'fixture-session')
    window.history.replaceState({}, '', '/employee')
    vi.mocked(fetch).mockImplementation(async input => String(input).endsWith('/me/portal-access') ? json({ role: 'employee', sections: ['devices', 'security', 'employee'], readOnly: false, customized: false }) : defaultFetch(input))
    render(<App />)
    await screen.findByRole('heading', { name: 'Employee fixture' })
    fireEvent.click(screen.getByRole('button', { name: 'Open portal home' }))
    expect(window.location.pathname).toBe('/dashboard')
    expect(await screen.findByRole('heading', { name: 'Personal dashboard fixture' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Dashboard fixture' })).not.toBeInTheDocument()
    fireEvent.click(nav('Employee'))
    expect(window.location.pathname).toBe('/employee')
    expect(await screen.findByRole('heading', { name: 'Employee fixture' })).toBeVisible()
  })

  it.each([['devices', 'security', 'employee'], []])('blocks disabled direct routes with sections %s', async (...sections) => {
    fixtureRole = 'employee'
    localStorage.setItem('itms_token', 'fixture-session')
    window.history.replaceState({}, '', '/patch')
    vi.mocked(fetch).mockImplementation(async input => String(input).endsWith('/me/portal-access') ? json({ role: 'employee', sections, readOnly: false, customized: true }) : defaultFetch(input))
    render(<App />)
    expect(await screen.findByRole('heading', { name: sections.length ? 'Section unavailable' : 'No portal sections enabled' })).toBeVisible()
    expect(screen.queryByText('Patch fixture')).not.toBeInTheDocument()
  })

  it('fails closed when portal verification is unavailable', async () => {
    localStorage.setItem('itms_token', 'fixture-session')
    window.history.replaceState({}, '', '/patch')
    vi.mocked(fetch).mockImplementation(async input => String(input).endsWith('/me/portal-access') ? json({}, 503) : defaultFetch(input))
    render(<App />)
    await screen.findByRole('heading', { name: 'Portal unavailable' })
    expect(screen.queryByText('Patch fixture')).not.toBeInTheDocument()
  })

  it('removes a revoked section from an already open portal on focus', async () => {
    fixtureRole = 'it_team'
    let sections = ['patch']
    localStorage.setItem('itms_token', 'fixture-session')
    window.history.replaceState({}, '', '/patch')
    vi.mocked(fetch).mockImplementation(async input => String(input).endsWith('/me/portal-access') ? json({ role: 'it_team', sections, readOnly: false, customized: true }) : defaultFetch(input))
    render(<App />)
    await screen.findByRole('heading', { name: 'Patch fixture' })
    sections = ['devices']
    act(() => window.dispatchEvent(new Event('focus')))
    await screen.findByRole('heading', { name: 'Section unavailable' })
    expect(screen.queryByText('Patch fixture')).not.toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'Primary navigation' })).queryByRole('button', { name: 'Patch' })).not.toBeInTheDocument()
  })

  it.each(['/login', '/login/', '/login?token=do-not-consume&auth_token=do-not-consume'])('renders only standalone LoginPage at %s', (path) => {
    window.history.replaceState({}, '', path)
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Welcome to ITMS' })).toBeVisible()
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /ITMS assistant/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open executive dashboard' })).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
    expect(localStorage.getItem('itms_token')).toBeNull()
  })

  it.each(['/devices', '/devices/', '/devices?source=bookmark'])('opens the main Devices page directly at %s with working sign-in', async (path) => {
    window.history.replaceState({}, '', path)
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Device Directory' })).toBeVisible()
    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Sign in' }))
    expect(window.location.pathname).toBe('/login')
    expect(screen.getByLabelText('Password')).toBeVisible()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })

  it.each(['dashboard', 'patch', 'security', 'employee', 'gatepass'])('initializes the exact /%s route and blocks signed-out operations', async (page) => {
    window.history.replaceState({}, '', `/${page}`)
    const { unmount } = render(<App />)
    expect(screen.getByRole('heading', { name: 'Sign-in required' })).toBeVisible()
    expect(fetch).not.toHaveBeenCalled()
    unmount()
    localStorage.setItem('itms_token', 'fixture-session')
    render(<App />)
    expect(await screen.findByRole('heading', { name: new RegExp(`${page} fixture`, 'i') })).toBeVisible()
    if (page !== 'dashboard') expect(nav(page[0].toUpperCase() + page.slice(1))).toHaveAttribute('aria-current', 'page')
  })

  it.each(['/unknown', '/devices/not-a-selected-device', '/patch/unsupported'])('does not fabricate details or pretend an unsupported route is a dashboard at %s', async (path) => {
    localStorage.setItem('itms_token', 'fixture-session')
    window.history.replaceState({}, '', path)
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Page unavailable' })).toBeVisible()
    expect(screen.queryByText(/Daniella|Endpoint /)).not.toBeInTheDocument()
    fireEvent.click(nav('Devices'))
    expect(window.location.pathname).toBe('/devices')
    expect(await screen.findByRole('heading', { name: 'Device Directory' })).toBeVisible()
  })

  it.each(['console', 'ssh', 'automation', 'reports', 'alerts', 'policies', 'logs', 'audit'])('recognizes nested patch route %s with sign-in guard and browser history', async child => {
    window.history.replaceState({}, '', `/patch/${child}`)
    const first = render(<App />)
    expect(screen.getByRole('heading', { name: 'Sign-in required' })).toBeVisible()
    expect(fetch).not.toHaveBeenCalled()
    first.unmount()
    localStorage.setItem('itms_token', 'fixture-session')
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Patch fixture' })).toBeVisible()
    expect(nav('Patch')).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('navigation', { name: 'Patch submenu' })).not.toBeInTheDocument()
    fireEvent.click(nav('Security'))
    await screen.findByRole('heading', { name: 'Security fixture' })
    await history('back', `/patch/${child}`)
    expect(await screen.findByRole('heading', { name: 'Patch fixture' })).toBeVisible()
    await history('forward', '/security')
    expect(await screen.findByRole('heading', { name: 'Security fixture' })).toBeVisible()
  })

  it('updates navbar URL and active page with real browser back and forward', async () => {
    localStorage.setItem('itms_token', 'fixture-session')
    window.history.replaceState({}, '', '/dashboard')
    render(<App />)
    await screen.findByRole('heading', { name: 'Dashboard fixture' })
    for (const page of ['Devices', 'Patch', 'Security', 'Employee', 'Gatepass']) {
      fireEvent.click(nav(page))
      expect(window.location.pathname).toBe(`/${page.toLowerCase()}`)
      expect(nav(page)).toHaveAttribute('aria-current', 'page')
      await screen.findByRole('heading', { name: page === 'Devices' ? 'Device Directory' : `${page} fixture` })
    }
    await history('back', '/employee')
    expect(await screen.findByRole('heading', { name: 'Employee fixture' })).toBeVisible()
    expect(nav('Employee')).toHaveAttribute('aria-current', 'page')
    await history('forward', '/gatepass')
    expect(await screen.findByRole('heading', { name: 'Gatepass fixture' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Open executive dashboard' }))
    expect(window.location.pathname).toBe('/dashboard')
    expect(await screen.findByRole('heading', { name: 'Dashboard fixture' })).toBeVisible()
  })

  it.each(['header', 'assistant', 'event'])('navigates %s sign-in to a shell-free login page', (source) => {
    window.history.replaceState({}, '', '/devices')
    render(<App />)
    if (source === 'header') fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Sign in' }))
    else if (source === 'assistant') {
      fireEvent.click(screen.getByRole('button', { name: 'Open ITMS assistant' }))
      fireEvent.click(within(screen.getByRole('region', { name: 'ITMS assistant' })).getByRole('button', { name: 'Sign in' }))
    } else act(() => window.dispatchEvent(new Event('itms-open-sign-in')))
    expect(window.location.pathname).toBe('/login')
    expect(screen.getByRole('heading', { name: 'Welcome to ITMS' })).toBeVisible()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'ITMS assistant' })).not.toBeInTheDocument()
  })

  it('replaces login URL with the dashboard and retains the login identity', async () => {
    window.history.replaceState({}, '', '/dashboard')
    vi.mocked(fetch).mockResolvedValueOnce(json({ token: 'fixture-session' })).mockImplementation(defaultFetch)
    render(<App />)
    act(() => window.dispatchEvent(new Event('itms-open-sign-in')))
    submitLogin()
    expect(await screen.findByRole('heading', { name: 'Dashboard fixture' })).toBeVisible()
    expect(window.location.pathname).toBe('/dashboard')
    expect(screen.getByRole('button', { name: 'Z1042' })).toBeVisible()
    fireEvent.click(nav('Devices'))
    expect(await screen.findByText(owner.fullName)).toBeVisible()
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/devices\/directory(?:\?.*)?$/), expect.objectContaining({ headers: { Authorization: 'Bearer fixture-session' } }))
    await history('back', '/dashboard')
    expect(screen.queryByText('Welcome to ITMS')).not.toBeInTheDocument()
    await history('forward', '/devices')
    expect(await screen.findByText(owner.fullName)).toBeVisible()
  })

  it.each(['401', 'nonJSON', 'empty'])('keeps /login without token or redirect on %s response', async (result) => {
    window.history.replaceState({}, '', '/login')
    vi.mocked(fetch).mockResolvedValue(result === '401' ? json({ error: 'Invalid credentials' }, 401) : result === 'nonJSON' ? new Response('<html>no</html>') : json({ token: ' ' }))
    render(<App />)
    submitLogin()
    await screen.findByRole('alert')
    expect(window.location.pathname).toBe('/login')
    expect(localStorage.getItem('itms_token')).toBeNull()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does not leave login for MFA until verification returns a nonempty token', async () => {
    window.history.replaceState({}, '', '/login')
    vi.mocked(fetch).mockResolvedValueOnce(json({ mfaRequired: true, email: 'fixture@example.test' }))
      .mockResolvedValueOnce(json({ token: '' })).mockResolvedValueOnce(json({ token: 'mfa-fixture' })).mockImplementation(defaultFetch)
    render(<App />)
    submitLogin()
    await screen.findByLabelText('MFA code')
    expect(window.location.pathname).toBe('/login')
    expect(localStorage.getItem('itms_token')).toBeNull()
    fireEvent.change(screen.getByLabelText('MFA code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify MFA' }))
    await screen.findByRole('alert')
    expect(window.location.pathname).toBe('/login')
    expect(localStorage.getItem('itms_token')).toBeNull()
    fireEvent.change(screen.getByLabelText('MFA code'), { target: { value: '654321' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify MFA' }))
    expect(await screen.findByRole('heading', { name: 'Dashboard fixture' })).toBeVisible()
    expect(window.location.pathname).toBe('/dashboard')
    expect(screen.getByRole('button', { name: 'Z1042' })).toBeVisible()
  })

  it('preserves selected device object across navigation/history, then discards it on account switch', async () => {
    localStorage.setItem('itms_token', 'fixture-session')
    window.history.replaceState({}, '', '/devices')
    render(<App />)
    await screen.findByText(owner.fullName)
    fireEvent.click(screen.getByRole('button', { name: 'View Assets' }))
    expect(window.location.pathname).toBe('/devices/physical-thinkpad')
    expect(await screen.findByRole('heading', { name: `Endpoint ${owner.fullName} ${owner.primaryAssetId}` })).toBeVisible()
    fireEvent.click(nav('Patch'))
    await screen.findByRole('heading', { name: 'Patch fixture' })
    await history('back', '/devices/physical-thinkpad')
    expect(await screen.findByRole('heading', { name: /^Endpoint/ })).toHaveTextContent(owner.fullName)
    auth('next-fixture-session', true)
    expect(screen.queryByRole('heading', { name: /^Endpoint/ })).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Page unavailable' })).toBeVisible()
  })

  it('logout removes privileged content and browser history cannot restore it', async () => {
    localStorage.setItem('itms_token', 'fixture-session')
    window.history.replaceState({}, '', '/devices')
    render(<App />)
    await screen.findByText(owner.fullName)
    fireEvent.click(nav('Patch'))
    await screen.findByRole('heading', { name: 'Patch fixture' })
    fireEvent.click(screen.getByRole('button', { name: 'Z1042' }))
    fireEvent.click(screen.getByRole('button', { name: 'Logout' }))
    expect(screen.queryByText('Patch fixture')).not.toBeInTheDocument()
    expect(localStorage.getItem('itms_token')).toBeNull()
    expect(window.location.pathname).toBe('/login')
    await history('back', '/login')
    expect(screen.getByRole('heading', { name: 'Welcome to ITMS' })).toBeVisible()
    expect(screen.queryByText(owner.fullName)).not.toBeInTheDocument()
    await history('forward', '/login')
    expect(screen.queryByText('Patch fixture')).not.toBeInTheDocument()
  })

  it.each([false, true])('redirects to login when the session is removed (cross-tab: %s)', async storage => {
    localStorage.setItem('itms_token', 'fixture-session')
    window.history.replaceState({}, '', '/patch')
    render(<App />)
    await screen.findByRole('heading', { name: 'Patch fixture' })
    auth(null, storage)
    expect(window.location.pathname).toBe('/login')
    expect(screen.getByRole('heading', { name: 'Welcome to ITMS' })).toBeVisible()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })

  it('logs out at ten idle minutes even if the logout API fails', async () => {
    localStorage.setItem('itms_token', 'fixture-session')
    localStorage.setItem('itms_user', 'fixture-user')
    window.history.replaceState({}, '', '/patch')
    const mounted = render(<App />)
    await screen.findByRole('heading', { name: 'Patch fixture' })
    vi.useFakeTimers()
    try {
      mounted.unmount()
      localStorage.setItem('itms-last-activity', String(Date.now()))
      const next = render(<App />)
      vi.mocked(fetch).mockRejectedValue(new Error('offline'))
      act(() => vi.advanceTimersByTime(idleLogoutMs - 1))
      expect(localStorage.getItem('itms_token')).toBe('fixture-session')
      act(() => vi.advanceTimersByTime(1))
      expect(localStorage.getItem('itms_token')).toBeNull()
      expect(localStorage.getItem('itms_user')).toBeNull()
      expect(localStorage.getItem('itms-last-activity')).toBeNull()
      expect(window.location.pathname).toBe('/login')
      expect(screen.getByRole('heading', { name: 'Welcome to ITMS' })).toBeVisible()
      expect(fetch).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer fixture-session' } }))
      next.unmount()
    } finally { vi.useRealTimers() }
  })

  it.each(['pointerdown', 'pointermove', 'keydown', 'scroll', 'wheel', 'touchstart'])('extends the idle deadline on %s, not on background work', event => {
    vi.useFakeTimers()
    localStorage.setItem('itms_token', 'fixture-session')
    window.history.replaceState({}, '', '/login')
    const mounted = render(<App />)
    try {
      act(() => vi.advanceTimersByTime(9 * 60 * 1000))
      fireEvent(window, new Event(event))
      act(() => vi.advanceTimersByTime(9 * 60 * 1000))
      expect(localStorage.getItem('itms_token')).toBe('fixture-session')
      act(() => vi.advanceTimersByTime(60 * 1000))
      expect(localStorage.getItem('itms_token')).toBeNull()
    } finally { mounted.unmount(); vi.useRealTimers() }
  })

  it('preserves the inactivity deadline across remounts and accepts activity from another tab', () => {
    vi.useFakeTimers()
    localStorage.setItem('itms_token', 'fixture-session')
    window.history.replaceState({}, '', '/login')
    let mounted = render(<App />)
    try {
      act(() => vi.advanceTimersByTime(9 * 60 * 1000))
      mounted.unmount()
      mounted = render(<App />)
      act(() => {
        localStorage.setItem('itms-last-activity', String(Date.now()))
        window.dispatchEvent(new StorageEvent('storage', { key: 'itms-last-activity' }))
        vi.advanceTimersByTime(9 * 60 * 1000)
      })
      expect(localStorage.getItem('itms_token')).toBe('fixture-session')
      mounted.unmount()
      mounted = render(<App />)
      act(() => vi.advanceTimersByTime(60 * 1000))
      expect(localStorage.getItem('itms_token')).toBeNull()
    } finally { mounted.unmount(); vi.useRealTimers() }
  })

  it.each(['focus', 'pageshow', 'pointerdown', 'visibilitychange'])('expires a sleeping tab before %s can revive the session', event => {
    vi.useFakeTimers()
    localStorage.setItem('itms_token', 'fixture-session')
    window.history.replaceState({}, '', '/login')
    const mounted = render(<App />)
    try {
      vi.setSystemTime(Date.now() + idleLogoutMs)
      fireEvent(event === 'visibilitychange' ? document : window, new Event(event))
      expect(localStorage.getItem('itms_token')).toBeNull()
    } finally { mounted.unmount(); vi.useRealTimers() }
  })

  it('starts a new deadline after sign-in and cancels timers on unmount', () => {
    vi.useFakeTimers()
    window.history.replaceState({}, '', '/login')
    const mounted = render(<App />)
    try {
      localStorage.setItem('itms-last-activity', String(Date.now() - idleLogoutMs))
      act(() => saveSession('new-fixture-session'))
      act(() => vi.advanceTimersByTime(idleLogoutMs - 1))
      expect(localStorage.getItem('itms_token')).toBe('new-fixture-session')
      mounted.unmount()
      act(() => vi.advanceTimersByTime(idleLogoutMs))
      expect(localStorage.getItem('itms_token')).toBe('new-fixture-session')
    } finally { mounted.unmount(); vi.useRealTimers() }
  })

  it('redirects an already idle session to login when the application reopens', () => {
    localStorage.setItem('itms_token', 'fixture-session')
    localStorage.setItem('itms-last-activity', String(Date.now() - idleLogoutMs))
    window.history.replaceState({}, '', '/patch')
    render(<App />)
    expect(localStorage.getItem('itms_token')).toBeNull()
    expect(window.location.pathname).toBe('/login')
    expect(screen.getByRole('heading', { name: 'Welcome to ITMS' })).toBeVisible()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })
})