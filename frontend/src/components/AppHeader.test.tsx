import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppHeader, PatchSubmenu } from './AppHeader'

const props = { activeView: 'devices' as const, context: 'Devices', darkMode: false, onChangeView: vi.fn(), onToggleTheme: vi.fn() }
const profile = { full_name: 'Fixture Owner', email: 'owner@example.test', emp_id: 'EMP-FIXTURE', role: 'it_team', status: 'active' }
function authenticate(token: string | null) {
  act(() => {
    if (token) localStorage.setItem('itms_token', token)
    else localStorage.removeItem('itms_token')
    window.dispatchEvent(new Event('itms-auth-changed'))
  })
}
describe('AppHeader account controls', () => {
  beforeEach(() => { localStorage.clear(); vi.stubGlobal('fetch', vi.fn()); Element.prototype.scrollIntoView = vi.fn() })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('exposes bookmarkable Patch submenu links with active state and native modified clicks', () => {
    const onNavigate = vi.fn()
    const view = render(<PatchSubmenu pathname="/patch" onNavigate={onNavigate} />)
    const submenu = within(screen.getByRole('navigation', { name: 'Patch submenu' }))
    const apps = submenu.getByRole('link', { name: 'Apps' })
    expect(apps).toHaveAttribute('href', '/patch/apps')
    expect(submenu.getByRole('link', { name: 'Patch console' })).toHaveAttribute('aria-current', 'page')
    for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
      // Cancel the browser's default only after checking our handler left it intact.
      const observe = (event: MouseEvent) => { expect(event.defaultPrevented).toBe(false); event.preventDefault() }
      document.addEventListener('click', observe, { once: true })
      fireEvent.click(apps, { [modifier]: true })
    }
    expect(onNavigate).not.toHaveBeenCalled()
    fireEvent.click(apps)
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('/patch/apps')
    view.rerender(<PatchSubmenu pathname="/patch/apps" onNavigate={onNavigate} />)
    expect(apps).toHaveAttribute('aria-current', 'page')
    view.rerender(<PatchSubmenu pathname="/patch/apps-services/" onNavigate={onNavigate} />)
    expect(apps).toHaveAttribute('aria-current', 'page')
    expect(submenu.getByRole('link', { name: 'Patch console' })).not.toHaveAttribute('aria-current')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['admin-manual-entry', 'admin-assets', 'admin-suppliers', 'admin-scripts'] as const)('selects Settings on %s only for verified administrators', activeView => {
    const onChangeView = vi.fn()
    const view = render(<AppHeader {...props} onChangeView={onChangeView} />)
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
    view.rerender(<AppHeader {...props} activeView={activeView} canAccessSettings onChangeView={onChangeView} />)
    const nav = within(screen.getByRole('navigation', { name: 'Primary navigation' }))
    for (const label of ['Admin computers', 'Suppliers', 'Installation scripts', 'Manual Entry']) expect(nav.queryByRole('button', { name: label })).not.toBeInTheDocument()
    fireEvent.click(nav.getByRole('button', { name: 'Settings' }))
    expect(onChangeView).toHaveBeenLastCalledWith('admin-manual-entry')
    expect(nav.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
    view.rerender(<AppHeader {...props} canAccessSettings onChangeView={onChangeView} />)
    expect(nav.getByRole('button', { name: 'Settings' })).not.toHaveAttribute('aria-current')
    expect(nav.getByRole('button', { name: 'Devices' })).toHaveAttribute('aria-current', 'page')
    view.rerender(<AppHeader {...props} onChangeView={onChangeView} />)
    expect(nav.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shows Sign in instead of a fabricated identity and requests App navigation', () => {
    const signIn = vi.fn()
    window.addEventListener('itms-open-sign-in', signIn)
    render(<AppHeader {...props} />)
    expect(screen.queryByText(/Alex_Admin|^AA$/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(signIn).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
    window.removeEventListener('itms-open-sign-in', signIn)
  })

  it('uses neutral Account, preserves real profile/settings, and immediately clears on logout', async () => {
    vi.mocked(fetch).mockImplementation((input) => String(input) === '/api/me/profile'
      ? Promise.resolve(new Response(JSON.stringify(profile)))
      : new Promise(() => {}))
    render(<AppHeader {...props} />)
    authenticate('fixture-session-a')
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Account settings' }))
    expect(await screen.findByText(profile.email)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Account' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Logout' }))
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible()
    expect(localStorage.getItem('itms_token')).toBeNull()
    expect(screen.queryByText(profile.full_name)).not.toBeInTheDocument()
    expect(fetch).toHaveBeenLastCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }))
  })

  it('shows the profile name instead of the login identity and clears it on logout', async () => {
    localStorage.setItem('itms_token', 'fixture-session')
    localStorage.setItem('itms-login-identity', 'Operator@example.test')
    vi.mocked(fetch).mockImplementation((input) => String(input) === '/api/auth/me'
      ? Promise.resolve(new Response(JSON.stringify(profile)))
      : new Promise(() => {}))
    render(<AppHeader {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: profile.full_name }))
    fireEvent.click(screen.getByRole('button', { name: 'Logout' }))
    expect(localStorage.getItem('itms-login-identity')).toBeNull()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible()
  })

  it('shows the profile name for a session created before login identity was stored', async () => {
    localStorage.setItem('itms_token', 'fixture-session')
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(profile)))
    render(<AppHeader {...props} />)
    expect(await screen.findByRole('button', { name: profile.full_name })).toBeVisible()
  })

  it('keeps account settings distinct from the administrator Settings navigation', async () => {
    const onChangeView = vi.fn()
    localStorage.setItem('itms_token', 'fixture-session-a')
    vi.mocked(fetch).mockImplementation((input) => String(input) === '/api/me/profile'
      ? Promise.resolve(new Response(JSON.stringify(profile)))
      : new Promise(() => {}))
    render(<AppHeader {...props} canAccessSettings onChangeView={onChangeView} />)
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    expect(screen.getAllByRole('button', { name: 'Settings' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Account settings' }))
    expect(await screen.findByText(profile.email)).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Account settings' })).toBeVisible()
    expect(onChangeView).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith('/api/me/profile', expect.objectContaining({ headers: { Authorization: 'Bearer fixture-session-a' } }))
  })

  it('does not restore a previous account profile from a late response', async () => {
    let resolve!: (response: Response) => void
    vi.mocked(fetch).mockReturnValue(new Promise<Response>((done) => { resolve = done }))
    localStorage.setItem('itms_token', 'fixture-session-a')
    render(<AppHeader {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(screen.getByRole('button', { name: 'Account settings' }))
    authenticate('fixture-session-b')
    await act(async () => resolve(new Response(JSON.stringify(profile))))
    expect(screen.getByRole('button', { name: 'Account' })).toBeVisible()
    expect(screen.queryByText(profile.full_name)).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    act(() => { localStorage.clear(); window.dispatchEvent(new StorageEvent('storage', { key: null })) })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible())
  })
})