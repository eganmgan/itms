import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

vi.mock('./lib/portalAccess', async importOriginal => {
  const actual = await importOriginal<typeof import('./lib/portalAccess')>()
  return { ...actual, usePortalAccess: () => ({ access: { role: 'super_admin', sections: actual.portalSections, readOnly: false, customized: false }, loading: false }) }
})

// Hold actual dynamic module resolution, not just a component's data request.
// Each route has its own cold lazy import; no React/module-cache resets needed.
const chunks = vi.hoisted(() => {
  function chunk() {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve, load: vi.fn(), render: vi.fn() }
  }
  return { patch: chunk(), assets: chunk(), suppliers: chunk(), scripts: chunk(), settings: chunk() }
})
vi.mock('./pages/PatchPage', async () => {
  chunks.patch.load()
  await chunks.patch.promise
  return { PatchPage: () => { chunks.patch.render(); return <h1>Lazy patch fixture</h1> } }
})
vi.mock('./admin-computers/AdminAssetsPage', async () => {
  chunks.assets.load()
  await chunks.assets.promise
  return { AdminAssetsPage: () => { chunks.assets.render(); return <h1>Lazy assets fixture</h1> } }
})
vi.mock('./admin-suppliers/AdminSuppliersPage', async () => {
  chunks.suppliers.load()
  await chunks.suppliers.promise
  return { AdminSuppliersPage: () => { chunks.suppliers.render(); return <h1>Lazy suppliers fixture</h1> } }
})
vi.mock('./admin-scripts/AdminScriptsPage', async () => {
  chunks.scripts.load()
  await chunks.scripts.promise
  return { AdminScriptsPage: () => { chunks.scripts.render(); return <h1>Lazy scripts fixture</h1> } }
})
vi.mock('./manual-entry/ManualEntryPage.tsx', async () => {
  chunks.settings.load()
  await chunks.settings.promise
  return { ManualEntryPage: () => { chunks.settings.render(); return <h1>Lazy settings fixture</h1> } }
})
vi.mock('./components/ChatAssistant', () => ({ ChatAssistant: () => null }))

const json = (role: string) => new Response(JSON.stringify({ role }), { headers: { 'Content-Type': 'application/json' } })
function account(token: string) {
  act(() => {
    if (token) localStorage.setItem('itms_token', token)
    else localStorage.removeItem('itms_token')
    window.dispatchEvent(new Event('itms-auth-changed'))
  })
}
function navigate(path: string) {
  act(() => {
    window.history.pushState({}, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
}

describe('cold route chunks and eager authorization', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async () => json('admin')))
  })
  afterEach(() => {
    localStorage.clear()
    window.history.replaceState({}, '', '/')
    vi.unstubAllGlobals()
  })

  it('renders standalone login immediately without loading operational or admin chunks', () => {
    window.history.replaceState({}, '', '/login')
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Welcome to ITMS' })).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    for (const chunk of Object.values(chunks)) expect(chunk.load).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('blocks signed-out imports, retains accessible navigation while loading, and ignores an abandoned route', async () => {
    window.history.replaceState({}, '', '/patch')
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Sign-in required' })).toBeVisible()
    expect(chunks.patch.load).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    account('first-account')
    expect(screen.getByRole('status')).toHaveTextContent('Loading Patch engine & remote operations')
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible()
    expect(screen.queryByRole('navigation', { name: 'Patch submenu' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Apps' })).not.toBeInTheDocument()
    expect(screen.getByRole('banner')).toBeVisible()
    await waitFor(() => expect(chunks.patch.load).toHaveBeenCalledTimes(1))
    act(() => window.dispatchEvent(new Event('itms-open-sign-in')))
    expect(window.location.pathname).toBe('/login')
    await act(async () => chunks.patch.resolve())
    expect(screen.getByRole('heading', { name: 'Welcome to ITMS' })).toBeVisible()
    expect(chunks.patch.render).not.toHaveBeenCalled()
    navigate('/patch')
    expect(await screen.findByRole('heading', { name: 'Lazy patch fixture' })).toBeVisible()
    expect(chunks.patch.load).toHaveBeenCalledTimes(1)
    account('')
    expect(screen.getByRole('heading', { name: 'Welcome to ITMS' })).toBeVisible()
    expect(window.location.pathname).toBe('/login')
    expect(screen.queryByText('Lazy patch fixture')).not.toBeInTheDocument()
  })

  it.each(['assets', 'suppliers', 'scripts'] as const)('verifies roles before importing %s and does not mount a late chunk after account change', async name => {
    const chunk = chunks[name]
    window.history.replaceState({}, '', `/admin/${name}`)
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Sign-in required' })).toBeVisible()
    expect(chunk.load).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()

    let resolveIdentity!: (response: Response) => void
    const pendingIdentity = new Promise<Response>(resolve => { resolveIdentity = resolve })
    vi.mocked(fetch).mockImplementation(() => pendingIdentity.then(response => response.clone()))
    account('pending-account')
    expect(screen.getByRole('status')).toHaveTextContent('Checking administrator access')
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Back to Settings' })).not.toBeInTheDocument()
    expect(chunk.load).not.toHaveBeenCalled()
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/auth/me')).toHaveLength(2)
    await act(async () => resolveIdentity(json('employee')))
    expect(screen.getByRole('alert')).toHaveTextContent('Only admin and super_admin')
    expect(chunk.load).not.toHaveBeenCalled()

    vi.mocked(fetch).mockImplementation(async () => json('super_admin'))
    fireEvent.click(screen.getByRole('button', { name: 'Check access again' }))
    await waitFor(() => expect(chunk.load).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('status')).toHaveTextContent('Loading')
    expect(screen.getByRole('navigation')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Back to Settings' })).toHaveAttribute('href', '/settings')
    expect(chunk.render).not.toHaveBeenCalled()

    vi.mocked(fetch).mockImplementation(async () => json('employee'))
    account('different-account')
    // The guard is immediately visible even with an unresolved privileged chunk.
    expect(screen.getByRole('status')).toHaveTextContent('Checking administrator access')
    await screen.findByRole('alert')
    await act(async () => chunk.resolve())
    expect(chunk.render).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Only admin and super_admin')
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Back to Settings' })).not.toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url) === '/api/auth/me')).toBe(true)

    vi.mocked(fetch).mockImplementation(async () => json('admin'))
    fireEvent.click(screen.getByRole('button', { name: 'Check access again' }))
    expect(await screen.findByRole('heading', { name: `Lazy ${name} fixture` })).toBeVisible()
    expect(chunk.load).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Settings' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Back to Settings' })).toBeVisible()
  })

  it('allows verified admins into Settings and ignores a late chunk after authorization is revoked', async () => {
    const paths = ['/settings', '/settings/employees', '/admin/manual-entry', '/admin/manual-entry/employees']
    window.history.replaceState({}, '', paths[0]); render(<App />)
    for (const path of paths) {
      navigate(path)
      expect(screen.getByRole('heading', { name: 'Welcome to ITMS' })).toBeVisible()
      expect(window.location.pathname).toBe('/login')
      expect(chunks.settings.load).not.toHaveBeenCalled()
    }
    expect(fetch).not.toHaveBeenCalled()
    let resolveIdentity!: (response: Response) => void
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(resolve => { resolveIdentity = resolve }))
    account('pending-settings-account')
    navigate(paths[0])
    expect(screen.getByRole('status')).toHaveTextContent('Checking administrator access')
    expect(chunks.settings.load).not.toHaveBeenCalled()
    await act(async () => resolveIdentity(json('employee')))
    for (const path of paths) {
      navigate(path)
      expect(screen.getByRole('alert')).toHaveTextContent('Only verified admin or super_admin')
      expect(chunks.settings.load).not.toHaveBeenCalled()
    }
    vi.mocked(fetch).mockImplementation(async () => json('super_admin'))
    fireEvent.click(screen.getByRole('button', { name: 'Check access again' }))
    await waitFor(() => expect(chunks.settings.load).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('status')).toHaveTextContent('Loading Settings')
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
    vi.mocked(fetch).mockImplementation(async () => json('employee'))
    account('regular-admin-account')
    await screen.findByRole('alert')
    await act(async () => chunks.settings.resolve())
    expect(chunks.settings.render).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url) === '/api/auth/me')).toBe(true)
    vi.mocked(fetch).mockImplementation(async () => json('admin'))
    fireEvent.click(screen.getByRole('button', { name: 'Check access again' }))
    expect(await screen.findByRole('heading', { name: 'Lazy settings fixture' })).toBeVisible()
  })
})