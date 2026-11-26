import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { AppHeader } from './components/AppHeader'
import { ChatAssistant } from './components/ChatAssistant'
import { LoginPage } from './components/LoginPage'
import { getToken, useAuthToken, useIdleLogout } from './lib/auth'
import { PortalReadOnlyContext, type PortalSection, usePortalAccess } from './lib/portalAccess'
import { useAdminAccess } from './admin-computers/api'
import type { DirectoryUser } from './pages/DevicesPage'
import type { AppView } from './types'

const AdminAssetsPage = lazy(() => import('./admin-computers/AdminAssetsPage').then(module => ({ default: module.AdminAssetsPage })))
const ManualEntryPage = lazy(() => import('./manual-entry/ManualEntryPage.tsx').then(module => ({ default: module.ManualEntryPage })))
const AdminSuppliersPage = lazy(() => import('./admin-suppliers/AdminSuppliersPage').then(module => ({ default: module.AdminSuppliersPage })))
const AdminScriptsPage = lazy(() => import('./admin-scripts/AdminScriptsPage').then(module => ({ default: module.AdminScriptsPage })))
const DashboardView = lazy(() => import('./pages/DashboardView').then(module => ({ default: module.DashboardView })))
const DeviceOverviewPage = lazy(() => import('./pages/DeviceOverviewPage').then(module => ({ default: module.DeviceOverviewPage })))
const DevicesPage = lazy(() => import('./pages/DevicesPage').then(module => ({ default: module.DevicesPage })))
const EmployeePage = lazy(() => import('./pages/EmployeePage').then(module => ({ default: module.EmployeePage })))
const GatepassPage = lazy(() => import('./pages/GatepassPage').then(module => ({ default: module.GatepassPage })))
const PatchPage = lazy(() => import('./pages/PatchPage').then(module => ({ default: module.PatchPage })))
const SecurityPage = lazy(() => import('./pages/SecurityPage').then(module => ({ default: module.SecurityPage })))

const titles: Record<AppView, string> = {
  'admin-manual-entry': 'Settings',
  'admin-assets': 'Manual computer administration',
  'admin-suppliers': 'Supplier administration',
  'admin-scripts': 'Application & service installation scripts',
  dashboard: 'Executive overview',
  devices: 'Devices & branch inventory',
  device: 'Endpoint inspection',
  patch: 'Patch engine & remote operations',
  security: 'SOC operations center',
  employee: 'Employee support hub',
  gatepass: 'Digital hardware gatepass',
}

const routes: Record<string, AppView> = {
  '/': 'dashboard', '/dashboard': 'dashboard', '/devices': 'devices', '/patch': 'patch',
  '/patch/console': 'patch', '/patch/ssh': 'patch',
  '/patch/automation': 'patch', '/patch/reports': 'patch', '/patch/alerts': 'patch',
  '/patch/policies': 'patch', '/patch/logs': 'patch', '/patch/audit': 'patch',
  '/security': 'security', '/employee': 'employee', '/gatepass': 'gatepass',
  '/admin/assets': 'admin-assets', '/admin-assets': 'admin-assets', '/admin/computers': 'admin-assets',
  '/admin/suppliers': 'admin-suppliers', '/admin/scripts': 'admin-scripts',
  '/settings': 'admin-manual-entry', '/settings/employees': 'admin-manual-entry', '/settings/applications': 'admin-manual-entry',
  '/settings/chat': 'admin-manual-entry',
  '/settings/watchdog': 'admin-manual-entry',
  '/admin/manual-entry': 'admin-manual-entry', '/admin/manual-entry/employees': 'admin-manual-entry',
}
const normalizePath = (path: string) => path.replace(/\/$/, '') || '/'
const portalHomeSection = (role: string | undefined, allowedSections?: readonly PortalSection[]) => {
  if (role === 'employee' && allowedSections && allowedSections.includes('employee')) return 'dashboard'
  return allowedSections && allowedSections.length > 0 ? allowedSections[0] : 'devices'
}
const portalHomePath = (role: string | undefined, allowedSections?: readonly PortalSection[]) => {
  const section = portalHomeSection(role, allowedSections)
  return section === 'dashboard' ? '/dashboard' : `/${section}`
}

export default function App() {
  const [pathname, setPathname] = useState(() => normalizePath(window.location.pathname))
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('itms-theme') === 'dark')
  const token = useAuthToken()
  const previousToken = useRef(token)
  const retiredAppsRoute = ['/patch/apps', '/patch/apps-services'].includes(pathname)
  const portalAccess = usePortalAccess(retiredAppsRoute ? '' : token)
  const portalReadOnly = portalAccess.access?.readOnly ?? false

  const navigate = (path: string, replace = false) => {
    if (replace) window.history.replaceState(null, '', path)
    else if (window.location.pathname !== path) window.history.pushState(null, '', path)
    setPathname(normalizePath(path))
  }

  useEffect(() => {
    const syncPath = () => {
      if (!getToken()) navigate('/login', true)
      else setPathname(normalizePath(window.location.pathname))
    }
    const signIn = () => navigate('/login')
    const signedOut = () => navigate('/login', true)
    window.addEventListener('popstate', syncPath)
    window.addEventListener('itms-open-sign-in', signIn)
    window.addEventListener('itms-signed-out', signedOut)
    return () => {
      window.removeEventListener('popstate', syncPath)
      window.removeEventListener('itms-open-sign-in', signIn)
      window.removeEventListener('itms-signed-out', signedOut)
    }
  }, [])

  useEffect(() => {
    if (previousToken.current && !token) navigate('/login', true)
    previousToken.current = token
  }, [token])

  useIdleLogout(token)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
    localStorage.setItem('itms-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])

  if (pathname === '/login') return <LoginPage isDarkMode={darkMode} onDarkModeChange={setDarkMode} onAuthenticated={() => navigate('/dashboard', true)} />

  return <PortalReadOnlyContext.Provider value={portalReadOnly}><Operations key={token} token={token} pathname={pathname} navigate={navigate} darkMode={darkMode} onToggleTheme={() => setDarkMode(value => !value)} allowedSections={portalAccess.access?.sections} portalRole={portalAccess.access?.role} portalCustomAccess={portalAccess.access?.customized ?? false} portalReadOnly={portalReadOnly} portalLoading={portalAccess.loading} portalError={portalAccess.error} /></PortalReadOnlyContext.Provider>
}

function Operations({ token, pathname, navigate, darkMode, onToggleTheme, allowedSections, portalRole, portalCustomAccess, portalReadOnly, portalLoading, portalError }: {
  token: string; pathname: string; navigate: (path: string, replace?: boolean) => void; darkMode: boolean; onToggleTheme: () => void; allowedSections?: readonly PortalSection[]; portalRole?: string; portalCustomAccess: boolean; portalReadOnly: boolean; portalLoading: boolean; portalError?: string
}) {
  const safePath = normalizePath(pathname)
  const [selectedDevice, setSelectedDevice] = useState<DirectoryUser | null>(null)
  const adminAccess = useAdminAccess(token)
  const devicePath = selectedDevice?.primaryAssetId ? `/devices/${encodeURIComponent(selectedDevice.primaryAssetId)}` : ''
  const deviceRoute = safePath.match(/^\/devices\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(apps|system|applications|services|updates|alerts|history))?$/i)
  const selectedRoute = devicePath && (safePath === devicePath || ['apps', 'system', 'applications', 'services', 'updates', 'alerts', 'history'].some(tab => safePath === `${devicePath}/${tab}`))
  const view = routes[safePath] ?? (deviceRoute || selectedRoute ? 'device' : undefined)
  const movedApps = ['/patch/apps-services', '/patch/apps'].includes(safePath)
  const sectionAllowed = (() => {
    if (!allowedSections || allowedSections.length === 0) return false
    if (view === 'dashboard') return portalRole === 'employee' ? allowedSections.includes('employee') : !portalCustomAccess
    if (view === 'device') return allowedSections.includes('devices')
    if (view === 'admin-manual-entry' || view === 'admin-assets' || view === 'admin-suppliers' || view === 'admin-scripts') return true
    if (!view) return true
    return allowedSections.includes(view as PortalSection)
  })()

  if (safePath.startsWith('/devices/') && !deviceRoute && !selectedRoute && selectedDevice && selectedDevice.primaryAssetId) {
    const fallbackPath = `/devices/${encodeURIComponent(selectedDevice.primaryAssetId)}`
    if (safePath !== fallbackPath) navigate(fallbackPath, true)
  }

  const context = view ? titles[view] : movedApps ? 'Device apps' : 'Page unavailable'
  const chatContext = view === 'device' && /\/(apps|applications)$/.test(pathname) ? 'Devices / Apps' : view === 'device' && pathname.endsWith('/services') ? 'Devices / Services' : context
  const settingsChild = view === 'admin-assets' || view === 'admin-suppliers' || view === 'admin-scripts'
  const homePath = portalHomePath(portalRole, allowedSections)

  useEffect(() => {
    if (portalCustomAccess && allowedSections && allowedSections.length > 0 && safePath === '/dashboard' && homePath !== '/dashboard' && window.location.pathname !== homePath) {
      navigate(homePath, true)
    }
  }, [allowedSections, homePath, navigate, portalCustomAccess, safePath])

  const renderView = () => {
    if (!token && view !== 'devices') return <section className="card p-6"><h1 className="text-xl font-bold">Sign-in required</h1><p className="my-3">Sign in to access ITMS operations.</p><button className="primary-button" onClick={() => navigate('/login')}>Sign in</button></section>
    if (portalError) return <section className="card p-6"><h1 className="text-xl font-bold">Portal unavailable</h1><p role="alert" className="my-3">Unable to verify portal access. Sign in again or contact your administrator.</p><button className="secondary-button" onClick={() => navigate('/login', true)}>Return to sign-in</button></section>
    if (movedApps) return <section className="space-y-3"><h1 className="text-xl font-bold">Apps moved to Devices</h1><a href="/devices" className="text-brand-600 underline" onClick={event => { if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate('/devices') }}>Open Devices</a></section>
    if (safePath === '/patch/apps' || safePath === '/patch/apps-services') return <section className="space-y-3"><h1 className="text-xl font-bold">Apps moved to Devices</h1><a href="/devices" className="text-brand-600 underline" onClick={event => { if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate('/devices') }}>Open Devices</a></section>
    if (token && allowedSections !== undefined && allowedSections.length === 0 && view && !['admin-manual-entry', 'admin-assets', 'admin-suppliers', 'admin-scripts'].includes(view)) return <section className="card p-6"><h1 className="text-xl font-bold">No portal sections enabled</h1><p role="alert" className="my-3">This account has no enabled portal sections. Contact an administrator to grant access.</p></section>
    if (token && allowedSections && view && !sectionAllowed && !['admin-manual-entry', 'admin-assets', 'admin-suppliers', 'admin-scripts'].includes(view)) return <section className="card p-6"><h1 className="text-xl font-bold">Section unavailable</h1><p role="alert" className="my-3">This section is not enabled for this account.</p><button className="secondary-button" onClick={() => navigate(portalHomePath(portalRole, allowedSections))}>Open portal home</button></section>
    if (portalLoading && !['admin-manual-entry', 'admin-assets', 'admin-suppliers', 'admin-scripts'].includes(view ?? '')) return <p role="status" aria-live="polite" aria-busy="true">Loading {context}…</p>
    switch (view) {
      case 'admin-manual-entry': return adminAccess.loading ? <p role="status" aria-live="polite" aria-busy="true">Checking administrator access…</p> : adminAccess.allowed ? <ManualEntryPage token={token} verifiedAdministrator={adminAccess.allowed} onDenied={adminAccess.revoke} employeeRoute={pathname.endsWith('/employees')} applicationsRoute={pathname.endsWith('/applications')} chatRoute={pathname.endsWith('/chat')} watchdogRoute={pathname.endsWith('/watchdog')} navigate={navigate} /> : <section className="card p-6"><h1 className="text-xl font-bold">Settings unavailable</h1><p role="alert" className="my-3">{adminAccess.error ? 'Unable to verify administrator access. No settings data was requested.' : 'Access denied. Only verified admin or super_admin accounts may use Settings.'}</p><button className="secondary-button" onClick={adminAccess.retry}>Check access again</button></section>
      case 'admin-suppliers':
      case 'admin-scripts': return adminAccess.loading ? <p role="status">Checking administrator access…</p> : adminAccess.allowed ? view === 'admin-suppliers' ? <AdminSuppliersPage token={token} onDenied={adminAccess.revoke} /> : <AdminScriptsPage token={token} onDenied={adminAccess.revoke} /> : <section className="card p-6"><h1 className="text-xl font-bold">Administration unavailable</h1><p role="alert" className="my-3">{adminAccess.error ? 'Unable to verify administrator access. No administration data was requested.' : 'Access denied. Only admin and super_admin accounts may access this page.'}</p><button className="secondary-button" onClick={adminAccess.retry}>Check access again</button></section>
      case 'admin-assets': return adminAccess.loading ? <p role="status">Checking administrator access…</p> : adminAccess.allowed ? <AdminAssetsPage token={token} onDenied={adminAccess.revoke} /> : <section className="card p-6"><h1 className="text-xl font-bold">Computer administration unavailable</h1><p role="alert" className="my-3">{adminAccess.error ? 'Unable to verify administrator access. No computer data was requested.' : 'Access denied. Only admin and super_admin accounts may manage manual computers.'}</p><button className="secondary-button" onClick={adminAccess.retry}>Check access again</button></section>
      case 'devices':
        return <DevicesPage onOpenDevice={(device) => {
          if (!device.primaryAssetId) return
          setSelectedDevice(device)
          navigate(`/devices/${encodeURIComponent(device.primaryAssetId)}`)
        }} />
      case 'device':
        return <DeviceOverviewPage device={selectedDevice} assetId={deviceRoute?.[1]} pathname={pathname} onNavigate={navigate} />
      case 'patch': return <PatchPage pathname={pathname} />
      case 'security': return <SecurityPage />
      case 'employee': return <EmployeePage role={portalRole} canManageWorkload={adminAccess.allowed} />
      case 'gatepass': return <GatepassPage />
      case 'dashboard': return portalRole === 'employee' && allowedSections?.includes('employee') ? <EmployeePage role="employee" dashboard /> : <DashboardView />
      default: return <section className="card p-6"><h1 className="text-xl font-bold">Page unavailable</h1><p className="my-3">Use navigation to open an existing page. For endpoint details, select a device from the directory.</p><button className="primary-button" onClick={() => navigate('/devices')}>Open Devices</button></section>
    }
  }

  return <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
    <AppHeader activeView={view === 'device' ? 'devices' : view ?? 'device'} context={context} pathname={pathname} onNavigate={navigate} darkMode={darkMode} canAccessSettings={adminAccess.allowed} allowedSections={allowedSections} portalRole={portalRole} onChangeView={(next) => navigate(next === 'admin-manual-entry' ? '/settings' : next.startsWith('admin-') ? `/admin/${next.slice(6)}` : `/${next}`)} onToggleTheme={onToggleTheme} />
    <main className="min-h-screen overflow-x-hidden bg-slate-50/50 p-4 pt-[128px] dark:bg-slate-950/50 sm:p-6 sm:pt-[132px] lg:p-8 lg:pt-[96px]">
      {portalReadOnly && <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" role="status">Auditor portal: read-only</div>}
      {settingsChild && adminAccess.allowed && <a href="/settings" className="mb-4 inline-block text-sm font-semibold text-brand-600 hover:underline" onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); navigate('/settings') } }}>Back to Settings</a>}
      <Suspense fallback={<section className="card p-6" role="status" aria-live="polite" aria-busy="true"><h1 className="text-xl font-bold">Loading {context}…</h1><p className="mt-3 text-sm text-slate-500">Please wait. Navigation remains available.</p></section>}>
        {renderView()}
      </Suspense>
    </main>
    {!portalReadOnly && <ChatAssistant token={token} context={chatContext} />}
  </div>
}