import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Copy, KeyRound, Search, ShieldCheck } from 'lucide-react'
import { Badge } from './ui'

interface ManagedEmployee {
  id: string
  emp_id: string
  full_name: string
  email: string
  status: 'active' | 'inactive'
  entity_id?: string | null
  dept_id?: string | null
  location_id?: string | null
  role?: string | null
  department?: string | null
  location?: string | null
  asset_count: number
}

interface UserListResponse {
  items: ManagedEmployee[]
  total: number
}

const portalRoles = [
  { value: 'employee', label: 'Employee Portal' },
  { value: 'it_team', label: 'IT Team Portal' },
  { value: 'auditor', label: 'Auditor Portal' },
  { value: 'super_admin', label: 'Super Admin Portal' },
]

function userIdFromPath(pathname = window.location.pathname) {
  const segments = pathname.split('/').filter(Boolean)
  return segments[0] === 'employee' && segments[1] === 'users' && segments[2] ? decodeURIComponent(segments[2]) : ''
}

function currentUserCanManage() {
  try {
    const user = JSON.parse(localStorage.getItem('itms_user') || 'null') as { role?: string } | null
    return user?.role === 'super_admin'
  } catch {
    return false
  }
}

function generateTemporaryPassword() {
  const random = new Uint8Array(12)
  crypto.getRandomValues(random)
  return `Itms!${Array.from(random, (value) => value.toString(16).padStart(2, '0')).join('')}Aa1`
}

async function userRequest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(payload.error || `User request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

export function EmployeeDirectory({ onNotice }: { onNotice: (message: string) => void }) {
  const [users, setUsers] = useState<ManagedEmployee[]>([])
  const [selectedUserId, setSelectedUserId] = useState(userIdFromPath)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [portalRole, setPortalRole] = useState('employee')
  const [temporaryPassword, setTemporaryPassword] = useState('')
  const canManage = currentUserCanManage()

  const loadUsers = useCallback(async () => {
    const token = localStorage.getItem('itms_token')
    if (!token) {
      setError('Sign in to view employee details.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const response = await userRequest<UserListResponse>('/users?paginate=1&page_size=200', token)
      setUsers(response.items)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Employees could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadUsers() }, [loadUsers])
  useEffect(() => {
    const syncRoute = () => setSelectedUserId(userIdFromPath())
    window.addEventListener('popstate', syncRoute)
    return () => window.removeEventListener('popstate', syncRoute)
  }, [])

  const selectedUser = users.find((user) => user.id === selectedUserId)
  useEffect(() => {
    if (selectedUser) setPortalRole(selectedUser.role || 'employee')
    setTemporaryPassword('')
    setError('')
  }, [selectedUser])

  const visibleUsers = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return users
    return users.filter((user) => [user.full_name, user.email, user.emp_id, user.department, user.location, user.role].some((value) => value?.toLowerCase().includes(query)))
  }, [search, users])

  function openDetails(user: ManagedEmployee) {
    window.history.pushState({}, '', `/employee/users/${encodeURIComponent(user.id)}`)
    setSelectedUserId(user.id)
  }

  function closeDetails() {
    window.history.pushState({}, '', '/employee/users')
    setSelectedUserId('')
    setTemporaryPassword('')
    setError('')
  }

  async function updatePortalAccess() {
    if (!selectedUser || !canManage) return
    const token = localStorage.getItem('itms_token')
    if (!token) return
    setSaving(true)
    setError('')
    try {
      await userRequest(`/users/${encodeURIComponent(selectedUser.id)}`, token, { method: 'PATCH', body: JSON.stringify({ role: portalRole }) })
      setUsers((current) => current.map((user) => user.id === selectedUser.id ? { ...user, role: portalRole } : user))
      onNotice(`Portal access updated for ${selectedUser.full_name}.`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Portal access could not be updated.')
    } finally {
      setSaving(false)
    }
  }

  async function resetPassword() {
    if (!selectedUser || !canManage) return
    const token = localStorage.getItem('itms_token')
    if (!token) return
    const nextPassword = generateTemporaryPassword()
    setSaving(true)
    setError('')
    try {
      await userRequest(`/users/${encodeURIComponent(selectedUser.id)}`, token, { method: 'PATCH', body: JSON.stringify({ initial_password: nextPassword }) })
      setTemporaryPassword(nextPassword)
      onNotice(`Password reset for ${selectedUser.full_name}.`)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Password could not be reset.')
    } finally {
      setSaving(false)
    }
  }

  if (selectedUserId) {
    if (loading) return <div className="py-14 text-center text-sm text-slate-500">Loading employee details...</div>
    if (!selectedUser) return <div className="space-y-4"><button className="secondary-button" onClick={closeDetails}><ArrowLeft size={16} />Employee directory</button><div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm font-semibold text-rose-700">Employee not found or unavailable.</div></div>

    return <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button className="secondary-button" onClick={closeDetails}><ArrowLeft size={16} />Employee directory</button>
        <Badge tone={selectedUser.status === 'active' ? 'green' : 'rose'}>{selectedUser.status}</Badge>
      </div>
      <section className="border-b pb-5">
        <div className="flex items-center gap-4"><span className="flex h-14 w-14 items-center justify-center rounded-md bg-blue-600 text-lg font-black text-white">{selectedUser.full_name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</span><div><h2 className="text-xl font-black">{selectedUser.full_name}</h2><p className="mt-1 text-sm text-slate-500">{selectedUser.email}</p></div></div>
      </section>
      {error && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700">{error}</div>}
      <div className="grid gap-x-8 gap-y-5 border-b pb-6 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {[['Employee ID', selectedUser.emp_id], ['Department', selectedUser.department || 'Unassigned'], ['Branch', selectedUser.location || 'Unassigned'], ['Portal access', portalRoles.find((role) => role.value === selectedUser.role)?.label || selectedUser.role || 'Employee Portal'], ['Assigned assets', String(selectedUser.asset_count)], ['Entity ID', selectedUser.entity_id || 'Not assigned'], ['Department ID', selectedUser.dept_id || 'Not assigned'], ['Location ID', selectedUser.location_id || 'Not assigned'], ['User ID', selectedUser.id]].map(([label, value]) => <div key={label}><p className="text-[10px] font-bold uppercase text-slate-400">{label}</p><p className="mt-1 break-all font-semibold">{value}</p></div>)}
      </div>
      <section className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-md border p-4"><div className="flex items-center gap-2"><ShieldCheck size={18} className="text-blue-600" /><h3 className="font-bold">Portal access</h3></div><p className="mt-2 text-xs text-slate-500">Choose which ITMS portal this user can access.</p><select className="field mt-4" aria-label="Portal access" value={portalRole} onChange={(event) => setPortalRole(event.target.value)} disabled={!canManage || saving}>{portalRoles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select><button className="primary-button mt-3" disabled={!canManage || saving || portalRole === selectedUser.role} onClick={() => void updatePortalAccess()}>Save access</button>{!canManage && <p className="mt-2 text-[11px] font-semibold text-amber-700">Super admin permission is required to change portal access.</p>}</div>
        <div className="rounded-md border p-4"><div className="flex items-center gap-2"><KeyRound size={18} className="text-amber-600" /><h3 className="font-bold">Reset password</h3></div><p className="mt-2 text-xs text-slate-500">Generate a strong one-time password for the employee.</p>{temporaryPassword ? <label className="mt-4 block text-xs font-bold text-slate-500">One-time password<div className="mt-2 flex gap-2"><input className="field font-mono" readOnly value={temporaryPassword} /><button className="secondary-button shrink-0" onClick={() => void navigator.clipboard.writeText(temporaryPassword)}><Copy size={16} />Copy</button></div></label> : <button className="secondary-button mt-4" disabled={!canManage || saving} onClick={() => void resetPassword()}><KeyRound size={16} />Reset password</button>}{!canManage && <p className="mt-2 text-[11px] font-semibold text-amber-700">Super admin permission is required to reset passwords.</p>}</div>
      </section>
    </div>
  }

  return <div className="space-y-4">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><label className="relative flex-1 sm:max-w-md"><Search className="absolute left-3 top-3 text-slate-400" size={17} /><input className="field pl-10" aria-label="Search employees" placeholder="Search name, email, ID, department or role" value={search} onChange={(event) => setSearch(event.target.value)} /></label><span className="text-xs font-bold text-slate-500">{visibleUsers.length} of {users.length} users</span></div>
    {error && <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-bold text-rose-700">{error}</div>}
    <div className="table-shell overflow-x-auto"><table className="data-table"><thead><tr>{['Employee', 'Employee ID', 'Department', 'Branch', 'Portal access', 'Assets', 'Status', 'Action'].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>{loading ? <tr><td colSpan={8} className="py-10 text-center text-slate-500">Loading employees...</td></tr> : visibleUsers.length === 0 ? <tr><td colSpan={8} className="py-10 text-center text-slate-500">No employees match this search.</td></tr> : visibleUsers.map((user) => <tr key={user.id}><td><div className="font-bold">{user.full_name}</div><div className="mt-1 text-xs text-slate-500">{user.email}</div></td><td className="font-mono text-xs">{user.emp_id}</td><td>{user.department || 'Unassigned'}</td><td>{user.location || 'Unassigned'}</td><td>{portalRoles.find((role) => role.value === user.role)?.label || user.role || 'Employee Portal'}</td><td>{user.asset_count}</td><td><Badge tone={user.status === 'active' ? 'green' : 'rose'}>{user.status}</Badge></td><td><button className="text-xs font-bold text-brand-600" onClick={() => openDetails(user)}>View details</button></td></tr>)}</tbody></table></div>
  </div>
}