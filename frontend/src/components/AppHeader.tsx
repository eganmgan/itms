import { useEffect, useRef, useState } from 'react'
import { ChevronDown, LogOut, Moon, Settings, Shield, Sun, User } from 'lucide-react'
import { Modal } from './ui'
import type { AppView } from '../types'
import { signOut } from '../lib/auth'
import type { PortalSection } from '../lib/portalAccess'

type Props = { activeView: AppView; context: string; darkMode: boolean; canAccessSettings?: boolean; portalRole?: string; allowedSections?: readonly PortalSection[]; pathname?: string; onNavigate?: (path: string) => void; onChangeView: (view: AppView) => void; onToggleTheme: () => void }

const navigation: Array<{ label: string; view: AppView }> = [
  { label: 'Devices', view: 'devices' }, { label: 'Patch', view: 'patch' }, { label: 'Security', view: 'security' }, { label: 'Employee', view: 'employee' }, { label: 'Gatepass', view: 'gatepass' },
]

// Render below the fixed header in the page flow, so this submenu stays visible
// on narrow screens without clipping links inside the primary navigation scroller.
export function PatchSubmenu({ pathname, onNavigate }: { pathname: string; onNavigate: (path: string) => void }) {
  const apps = ['/patch/apps-services', '/patch/apps'].includes(pathname.replace(/\/$/, ''))
  return <nav aria-label="Patch submenu" className="mb-5 flex flex-wrap items-center gap-2 rounded-xl border bg-white p-3 dark:bg-slate-900">
    <span className="px-2 text-xs font-extrabold uppercase text-slate-500">Patch</span>
    {[
      { label: 'Apps', path: '/patch/apps', active: apps },
      { label: 'Patch console', path: '/patch', active: pathname === '/patch' || pathname === '/patch/console' },
    ].map(item => <a key={item.path} href={item.path} aria-current={item.active ? 'page' : undefined} className={item.active ? 'primary-button' : 'secondary-button'} onClick={event => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      onNavigate(item.path)
    }}>{item.label}</a>)}
  </nav>
}

export function AppHeader({ activeView, context, darkMode, canAccessSettings = false, portalRole, allowedSections, onChangeView, onToggleTheme }: Props) {
  const visibleNavigation = [...navigation.filter(item => !allowedSections || allowedSections.includes(item.view as PortalSection)), ...(canAccessSettings ? [{ label: 'Settings', view: 'admin-manual-entry' as const }] : [])]
  const selectedView = canAccessSettings && ['admin-assets', 'admin-suppliers', 'admin-scripts'].includes(activeView) ? 'admin-manual-entry' : activeView
  const homeView = canAccessSettings || !allowedSections ? 'dashboard' : portalRole === 'employee' && allowedSections.includes('employee') ? 'dashboard' : allowedSections[0] || 'devices'
  const [profileOpen, setProfileOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [profile, setProfile] = useState<{ full_name: string; email: string; emp_id: string; role: string; status: string } | null>(null)
  const [profileError, setProfileError] = useState('')
  const [token, setToken] = useState(() => localStorage.getItem('itms_token'))
  const [accountName, setAccountName] = useState<{ token: string; name: string } | null>(null)
  const [identityError, setIdentityError] = useState('')
  const profileGeneration = useRef(0)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const invalidateProfile = () => { ++profileGeneration.current }
    const syncAccount = () => {
      invalidateProfile()
      setToken(localStorage.getItem('itms_token'))
      setIdentityError(''); setProfile(null); setProfileError(''); setProfileOpen(false); setSettingsOpen(false)
    }
    const onStorage = (event: StorageEvent) => { if (event.key === 'itms_token' || event.key === null) syncAccount() }
    window.addEventListener('itms-auth-changed', syncAccount)
    window.addEventListener('storage', onStorage)
    return () => {
      invalidateProfile()
      window.removeEventListener('itms-auth-changed', syncAccount)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    const loadIdentity = async () => {
      try {
        const response = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
        if (!response.ok) throw new Error('Unable to load account identity.')
        const user = await response.json() as { full_name?: unknown }
        const name = typeof user.full_name === 'string' ? user.full_name.trim() : ''
        if (!name) throw new Error('Account name unavailable.')
        if (!controller.signal.aborted && token === localStorage.getItem('itms_token')) setAccountName({ token, name })
      } catch (error) {
        if (!controller.signal.aborted && token === localStorage.getItem('itms_token')) setIdentityError(error instanceof Error ? error.message : 'Account identity unavailable.')
      }
    }
    void loadIdentity()
    return () => controller.abort()
  }, [token])

  useEffect(() => {
    const dismiss = (event: MouseEvent) => { if (!popoverRef.current?.contains(event.target as Node)) setProfileOpen(false) }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [])

  async function openSettings() {
    const generation = ++profileGeneration.current
    setProfileOpen(false)
    setSettingsOpen(true)
    setProfile(null)
    setProfileError('')
    const token = localStorage.getItem('itms_token')
    if (!token) { setProfileError('Sign in to your ITMS account to load profile settings.'); return }
    try {
      const response = await fetch('/api/me/profile', { headers: { Authorization: `Bearer ${token}` } })
      const payload = await response.json() as { full_name?: string; email?: string; emp_id?: string; role?: string; status?: string; error?: string }
      if (generation !== profileGeneration.current || token !== localStorage.getItem('itms_token')) return
      if (!response.ok) throw new Error(payload.error || 'Profile settings unavailable')
      setProfile({ full_name: payload.full_name || '', email: payload.email || '', emp_id: payload.emp_id || '', role: payload.role || '', status: payload.status || '' })
    } catch (error) {
      if (generation === profileGeneration.current && token === localStorage.getItem('itms_token')) setProfileError(error instanceof Error ? error.message : 'Profile settings unavailable')
    }
  }

  function logout() {
    signOut()
    setProfileOpen(false)
  }

  return <><header className="fixed inset-x-0 top-0 z-40 flex h-[112px] flex-wrap items-center border-b bg-white px-4 shadow-sm dark:bg-slate-900 lg:h-[64px] lg:flex-nowrap lg:px-6">
    <button className="group flex min-w-[190px] items-center gap-3 text-left" onClick={() => onChangeView(homeView)} aria-label={canAccessSettings || !allowedSections ? 'Open executive dashboard' : 'Open portal home'}>
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white shadow-md shadow-blue-500/20 transition group-hover:bg-brand-700"><Shield size={20} /></span>
      <span><strong className="block text-xl font-black leading-5 tracking-wider transition group-hover:text-brand-600">ITMS</strong><small className="block max-w-[170px] truncate font-mono text-[10px] font-bold text-brand-600 dark:text-blue-400">{context}</small></span>
    </button>
    <nav className="order-last flex w-full items-center justify-between gap-1 overflow-x-auto rounded-2xl border bg-slate-100/80 p-1.5 dark:bg-slate-950 lg:order-none lg:mx-auto lg:w-auto lg:justify-center" aria-label="Primary navigation">{visibleNavigation.map((item) => <button key={item.view} aria-current={selectedView === item.view ? 'page' : undefined} onClick={() => onChangeView(item.view)} className={`h-8 shrink-0 rounded-xl px-2 text-[11px] font-bold transition lg:px-4 lg:text-xs ${selectedView === item.view ? 'bg-brand-600 text-white shadow-md shadow-blue-500/20' : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'}`}>{item.label}</button>)}</nav>
    <div className="ml-auto flex items-center gap-2">
      <button className="icon-button" onClick={onToggleTheme} title={darkMode ? 'Use light mode' : 'Use dark mode'} aria-label={darkMode ? 'Use light mode' : 'Use dark mode'}>{darkMode ? <Sun size={18} /> : <Moon size={18} />}</button>
      <div className="popover-container relative" ref={popoverRef}>
        {token ? <button onClick={() => setProfileOpen((value) => !value)} className="flex h-10 items-center gap-3 rounded-xl border bg-slate-100 p-1.5 pl-3 transition hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700" aria-label={accountName?.token === token ? accountName.name : 'Account'} title={identityError || undefined} aria-expanded={profileOpen}><span className="hidden text-xs font-bold sm:block">{accountName?.token === token ? accountName.name : 'Account'}</span><span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-xs font-bold text-white"><User size={16} /></span><ChevronDown size={14} className="text-slate-500" /></button> : <button className="primary-button" onClick={() => window.dispatchEvent(new Event('itms-open-sign-in'))}>Sign in</button>}
        {token && profileOpen && <div className="absolute right-0 mt-2 w-48 overflow-hidden rounded-2xl border bg-white p-2 shadow-xl dark:bg-slate-900"><button onClick={() => void openSettings()} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"><Settings size={16} className="text-slate-500" />Account settings</button><div className="my-1 border-t" /><button onClick={() => void logout()} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-semibold text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/30"><LogOut size={16} />Logout</button></div>}
      </div>
    </div>
  </header>{settingsOpen && <Modal title="Account settings" onClose={() => setSettingsOpen(false)}>{profileError ? <div className="p-5 text-sm font-semibold text-amber-700">{profileError}</div> : profile ? <div className="grid gap-4 p-5 sm:grid-cols-2"><div><p className="text-xs font-bold text-slate-400">Name</p><p className="mt-1 font-semibold">{profile.full_name}</p></div><div><p className="text-xs font-bold text-slate-400">Email</p><p className="mt-1 font-semibold">{profile.email}</p></div><div><p className="text-xs font-bold text-slate-400">Employee ID</p><p className="mt-1 font-semibold">{profile.emp_id || 'Not assigned'}</p></div><div><p className="text-xs font-bold text-slate-400">Role · Status</p><p className="mt-1 font-semibold capitalize">{profile.role.replaceAll('_', ' ')} · {profile.status}</p></div></div> : <div className="p-5 text-sm text-slate-500">Loading profile settings...</div>}</Modal>}</>
}