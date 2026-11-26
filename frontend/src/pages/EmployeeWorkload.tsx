import { useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, Search } from 'lucide-react'
import { Badge, Modal } from '../components/ui'
import { useAuthToken } from '../lib/auth'

type Ticket = {
  id: string
  ticketNumber?: string
  employee: string
  owner: string
  ownerId?: string | null
  category: string
  issue: string
  status: string
  createdAt: string
  updatedAt: string
  comments: Array<{ id: string; author: string; note: string; createdAt: string }>
  notes: string
}

type Task = {
  id: string
  taskNumber: string
  title: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'low' | 'medium' | 'high' | 'critical'
  dueDate: string
  createdAt: string
  updatedAt: string
  assignee: { id: string | null; fullName: string }
  createdBy: { id: string; fullName: string }
}

type User = { id: string; full_name: string; role?: string }
type PersonWorkload = { id: string; name: string; role: string; tickets: Ticket[]; tasks: Task[] }
type WorkloadDetail = { person: PersonWorkload; kind: 'tickets' | 'tasks' }

class WorkloadApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function workloadRequest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const controller = init?.signal ? undefined : new AbortController()
  const timeout = controller ? window.setTimeout(() => controller.abort(), 10000) : undefined
  try {
    const response = await fetch(`/api${path}`, {
      ...init,
      signal: init?.signal ?? controller?.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string }
      throw new WorkloadApiError(payload.error || `Workload request failed (${response.status})`, response.status)
    }
    return response.json() as Promise<T>
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout)
  }
}

function isTaskList(value: unknown): value is { items: Task[] } {
  return !!value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)
}

function isUserList(value: unknown): value is User[] | { items: User[] } {
  return Array.isArray(value) || (!!value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items))
}

function taskStatusLabel(status: Task['status']) {
  return status.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase())
}

export function EmployeeWorkload({ tickets, ticketsReady, onOpenTicket }: {
  tickets: Ticket[]
  ticketsReady: boolean
  onOpenTicket: (ticket: Ticket) => void
}) {
  const token = useAuthToken()
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ key: string; tasks: Task[]; users: User[]; error: string }>({ key: '', tasks: [], users: [], error: '' })
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<WorkloadDetail | null>(null)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [createUncertain, setCreateUncertain] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const key = `${token}:${revision}`

  useEffect(() => {
    if (!token) {
      setState({ key, tasks: [], users: [], error: 'Sign in to load workload counts.' })
      return
    }
    const controller = new AbortController()
    let active = true
    const timeout = window.setTimeout(() => controller.abort(), 8000)
    const current = () => active && token === localStorage.getItem('itms_token')
    void (async () => {
      try {
        const [taskData, userData] = await Promise.all([
          workloadRequest<unknown>('/tasks', token, { signal: controller.signal, cache: 'no-store' }),
          workloadRequest<unknown>('/users?status=active', token, { signal: controller.signal, cache: 'no-store' }),
        ])
        if (!isTaskList(taskData) || !isUserList(userData)) throw new Error('Invalid workload data')
        const users = Array.isArray(userData) ? userData : userData.items
        if (current() && !controller.signal.aborted) {
          setState({ key, tasks: taskData.items, users, error: '' })
          setCreateUncertain(false)
        }
      } catch (error) {
        if (current()) setState({ key, tasks: [], users: [], error: controller.signal.aborted ? 'Workload data request timed out. Refresh to try again.' : error instanceof Error ? error.message : 'Workload data unavailable.' })
      } finally { window.clearTimeout(timeout) }
    })()
    return () => { active = false; controller.abort(); window.clearTimeout(timeout) }
  }, [key, token])

  const loaded = state.key === key && !state.error
  const itTeamAssignees = state.users.filter(user => user.role === 'it_team')
  const superAdminAssignees = state.users.filter(user => user.role === 'super_admin')
  const taskAssignees = [...itTeamAssignees, ...superAdminAssignees]
  const people = useMemo(() => {
    const grouped = new Map<string, PersonWorkload>()
    const ensure = (id: string, name: string, role = '') => {
      const key = id || 'unassigned'
      let person = grouped.get(key)
      if (!person) {
        person = { id: key, name: name || (key === 'unassigned' ? 'Unassigned' : 'Unknown user'), role, tickets: [], tasks: [] }
        grouped.set(key, person)
      } else if (!person.role && role) person.role = role
      return person
    }
    state.users.forEach(user => ensure(user.id, user.full_name, user.role || ''))
    if (ticketsReady) tickets.forEach(ticket => ensure(ticket.ownerId || '', ticket.owner || 'Unassigned').tickets.push(ticket))
    state.tasks.forEach(task => ensure(task.assignee.id || '', task.assignee.fullName || 'Unassigned').tasks.push(task))
    return [...grouped.values()].sort((left, right) =>
      right.tickets.length + right.tasks.length - left.tickets.length - left.tasks.length || left.name.localeCompare(right.name))
  }, [state.tasks, state.users, tickets, ticketsReady])
  const visiblePeople = useMemo(() => {
    const value = query.trim().toLowerCase()
    return value ? people.filter(person => `${person.name} ${person.role}`.toLowerCase().includes(value)) : people
  }, [people, query])
  const activeTasks = state.tasks.filter(task => task.status === 'pending' || task.status === 'in_progress').length
  const unassignedTickets = ticketsReady ? tickets.filter(ticket => !ticket.ownerId).length : null

  async function createTask(form: HTMLFormElement) {
    if (!token || busy) return
    const data = new FormData(form)
    const title = String(data.get('title') || '').trim()
    const assigneeId = String(data.get('assigneeId') || '')
    if (!title || !taskAssignees.some(user => user.id === assigneeId)) {
      setActionError('Enter a task name and choose an active IT team or super-admin assignee.')
      return
    }
    setBusy(true)
    setActionError('')
    try {
      const result = await workloadRequest<{ id: string; taskNumber: string }>('/tasks', token, {
        method: 'POST',
        body: JSON.stringify({
          title,
          description: String(data.get('description') || '').trim(),
          assigneeId,
          priority: String(data.get('priority') || 'medium'),
          dueDate: String(data.get('dueDate') || ''),
        }),
      })
      if (!result.id || !result.taskNumber) throw new Error('Task creation was not confirmed.')
      setCreateOpen(false)
      setNotice(`${result.taskNumber} created and assigned.`)
      setRevision(value => value + 1)
    } catch (error) {
      if (error instanceof WorkloadApiError && error.status < 500) setActionError(error.message)
      else {
        setCreateUncertain(true)
        setActionError('Task creation could not be confirmed. Refresh the task list before trying again.')
      }
    } finally { setBusy(false) }
  }

  async function updateTask(form: HTMLFormElement) {
    if (!token || !selectedTask || busy) return
    const data = new FormData(form)
    const assigneeId = String(data.get('assigneeId') || '')
    const update: { status: string; assigneeId?: string; dueDate: string } = {
      status: String(data.get('status')),
      dueDate: String(data.get('dueDate') || ''),
    }
    if (assigneeId !== (selectedTask.assignee.id || '')) update.assigneeId = assigneeId
    setBusy(true)
    setActionError('')
    try {
      await workloadRequest(`/tasks/${encodeURIComponent(selectedTask.id)}`, token, {
        method: 'PATCH',
        body: JSON.stringify(update),
      })
      setSelectedTask(null)
      setNotice(`${selectedTask.taskNumber} updated.`)
      setRevision(value => value + 1)
    } catch (error) {
      setActionError(error instanceof WorkloadApiError && error.status < 500 ? error.message : 'Task update could not be confirmed. Refresh the workload to verify the changes.')
    } finally { setBusy(false) }
  }

  return <section aria-label="Admin counts and workload" className="space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold">Team workload</h2>
        <p className="mt-1 text-xs text-slate-500">Ticket and task assignments by person. Select a count or item to open its details.</p>
      </div>
      <div className="flex gap-2">
        <button className="secondary-button" disabled={!token || !loaded} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} />Refresh</button>
        <button className="primary-button" disabled={!loaded || taskAssignees.length === 0 || createUncertain} onClick={() => { setActionError(''); setCreateOpen(true) }}><Plus size={16} />Create task</button>
      </div>
    </div>
    {loaded && taskAssignees.length === 0 && <p role="status" className="text-sm text-slate-500">No active IT team or super-admin users are available to assign tasks.</p>}
    {notice && <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800">{notice}</p>}
    {state.error && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{state.error} <button type="button" className="ml-2 underline" onClick={() => setRevision(value => value + 1)}>Retry</button></div>}
    {createUncertain && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Task submission is unconfirmed. Refresh the list before creating another task.</p>}
    {!ticketsReady && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">Ticket assignments are unavailable; refresh the Employee page to retry. Ticket counts are not shown as zero.</p>}
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {[
        ['Tickets', ticketsReady ? tickets.length : '—'],
        ['Tasks', loaded ? state.tasks.length : '—'],
        ['Active tasks', loaded ? activeTasks : '—'],
        ['Unassigned tickets', unassignedTickets ?? '—'],
      ].map(([label, value]) => <div key={label} className="card p-4"><dt className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</dt><dd className="mt-2 text-2xl font-black">{value}</dd></div>)}
    </dl>
    <div className="space-y-3">
      <label className="relative block sm:max-w-md"><Search className="absolute left-3 top-3 text-slate-400" size={17} /><input className="field pl-10" aria-label="Search workload by person" placeholder="Search people" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="table-shell overflow-x-auto"><table className="data-table">
        <thead><tr>{['Person', 'Tickets', 'Tasks', 'Active tasks'].map(heading => <th key={heading}>{heading}</th>)}</tr></thead>
        <tbody>
          {!loaded && !state.error && <tr><td colSpan={4} className="py-10 text-center text-slate-500">Loading people and tasks...</td></tr>}
          {loaded && visiblePeople.length === 0 && <tr><td colSpan={4} className="py-10 text-center text-slate-500">No matching workload.</td></tr>}
          {loaded && visiblePeople.map(person => <tr key={person.id}>
            <td><span className="font-bold">{person.name}</span>{person.role && <span className="mt-1 block text-[10px] capitalize text-slate-500">{person.role.replaceAll('_', ' ')}</span>}</td>
            <td><button className="font-bold text-brand-600 underline disabled:text-slate-400 disabled:no-underline" disabled={!ticketsReady || person.tickets.length === 0} aria-label={`View ${person.tickets.length} tickets for ${person.name}`} onClick={() => setDetail({ person, kind: 'tickets' })}>{ticketsReady ? person.tickets.length : '—'}</button></td>
            <td><button className="font-bold text-brand-600 underline disabled:text-slate-400 disabled:no-underline" disabled={person.tasks.length === 0} aria-label={`View ${person.tasks.length} tasks for ${person.name}`} onClick={() => setDetail({ person, kind: 'tasks' })}>{person.tasks.length}</button></td>
            <td>{person.tasks.filter(task => task.status === 'pending' || task.status === 'in_progress').length}</td>
          </tr>)}
        </tbody>
      </table></div>
    </div>
    <section aria-label="Task list" className="space-y-3">
      <h3 className="font-semibold">Tasks</h3>
      <div className="table-shell overflow-x-auto"><table className="data-table">
        <thead><tr>{['Task', 'Assignee', 'Priority', 'Status', 'Due date', 'Details'].map(heading => <th key={heading}>{heading}</th>)}</tr></thead>
        <tbody>
          {!loaded && !state.error && <tr><td colSpan={6} className="py-8 text-center text-slate-500">Loading tasks...</td></tr>}
          {loaded && state.tasks.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-slate-500">No tasks created yet.</td></tr>}
          {loaded && state.tasks.map(task => <tr key={task.id}>
            <td><span className="font-mono text-[10px] text-slate-500">{task.taskNumber}</span><span className="mt-1 block font-semibold">{task.title}</span></td>
            <td>{task.assignee.fullName || 'Unassigned'}</td>
            <td><Badge tone={task.priority === 'critical' || task.priority === 'high' ? 'rose' : task.priority === 'medium' ? 'amber' : 'slate'}>{task.priority}</Badge></td>
            <td><Badge tone={task.status === 'completed' ? 'green' : task.status === 'cancelled' ? 'slate' : task.status === 'in_progress' ? 'blue' : 'amber'}>{taskStatusLabel(task.status)}</Badge></td>
            <td>{task.dueDate || '—'}</td>
            <td><button className="font-bold text-brand-600 underline" onClick={() => { setActionError(''); setSelectedTask(task) }}>Open details</button></td>
          </tr>)}
        </tbody>
      </table></div>
    </section>

    {detail && <Modal title={`${detail.kind === 'tickets' ? 'Tickets' : 'Tasks'} · ${detail.person.name}`} onClose={() => setDetail(null)}>
      <div className="space-y-2 p-4">
        {detail.kind === 'tickets' ? detail.person.tickets.map(ticket => <button key={ticket.id} className="block w-full rounded-lg border p-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800" onClick={() => { setDetail(null); onOpenTicket(ticket) }}>
          <span className="font-mono text-[10px] text-slate-500">{ticket.ticketNumber || ticket.id}</span>
          <span className="mt-1 block font-semibold">{ticket.category} · {ticket.issue}</span>
          <span className="mt-1 block text-xs text-slate-500">{ticket.status} · Requested by {ticket.employee}</span>
        </button>) : detail.person.tasks.map(task => <button key={task.id} className="block w-full rounded-lg border p-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800" onClick={() => { setDetail(null); setActionError(''); setSelectedTask(task) }}>
          <span className="font-mono text-[10px] text-slate-500">{task.taskNumber}</span>
          <span className="mt-1 block font-semibold">{task.title}</span>
          <span className="mt-1 block text-xs text-slate-500">{taskStatusLabel(task.status)} · {task.priority} priority</span>
        </button>)}
      </div>
    </Modal>}
    {createOpen && <Modal title="Create task" onClose={() => { if (!busy) setCreateOpen(false) }}>
      <form className="space-y-4 p-5" onSubmit={event => { event.preventDefault(); void createTask(event.currentTarget) }}>
        <label className="block text-sm">Task name<input className="field mt-2" name="title" required maxLength={200} disabled={busy} /></label>
        <label className="block text-sm">Details<textarea className="field mt-2 h-24 py-3" name="description" maxLength={4000} disabled={busy} /></label>
        <label className="block text-sm">Assign to IT team or super admin<select className="field mt-2" name="assigneeId" defaultValue="" required disabled={busy}><option value="" disabled>Select a person</option>{itTeamAssignees.length > 0 && <optgroup label="IT team">{itTeamAssignees.map(user => <option key={user.id} value={user.id}>{user.full_name}</option>)}</optgroup>}{superAdminAssignees.length > 0 && <optgroup label="Super admin">{superAdminAssignees.map(user => <option key={user.id} value={user.id}>{user.full_name}</option>)}</optgroup>}</select></label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">Priority<select className="field mt-2" name="priority" defaultValue="medium" disabled={busy}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label>
          <label className="block text-sm">Due date<input className="field mt-2" name="dueDate" type="date" disabled={busy} /></label>
        </div>
        {actionError && <p role="alert" className="text-sm text-rose-700">{actionError}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="secondary-button" disabled={busy} onClick={() => setCreateOpen(false)}>Cancel</button>{createUncertain && <button type="button" className="secondary-button" disabled={busy} onClick={() => { setCreateOpen(false); setRevision(value => value + 1) }}>Refresh tasks</button>}<button className="primary-button" disabled={busy || !taskAssignees.length || createUncertain}><Plus size={16} />{busy ? 'Creating...' : 'Create task'}</button></div>
      </form>
    </Modal>}
    {selectedTask && <Modal title={`${selectedTask.taskNumber} · Task details`} onClose={() => { if (!busy) setSelectedTask(null) }}>
      <form className="space-y-4 p-5" onSubmit={event => { event.preventDefault(); void updateTask(event.currentTarget) }}>
        <div><h3 className="font-semibold">{selectedTask.title}</h3><p className="mt-2 whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">{selectedTask.description || 'No additional details.'}</p></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">Status<select className="field mt-2" name="status" defaultValue={selectedTask.status} disabled={busy}><option value="pending">Pending</option><option value="in_progress">In progress</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></label>
          <label className="block text-sm">Assignee<select className="field mt-2" name="assigneeId" defaultValue={selectedTask.assignee.id || ''} disabled={busy}><option value="">Unassigned</option>{selectedTask.assignee.id && !taskAssignees.some(user => user.id === selectedTask.assignee.id) && <option value={selectedTask.assignee.id}>{selectedTask.assignee.fullName} (current assignment)</option>}{itTeamAssignees.length > 0 && <optgroup label="IT team">{itTeamAssignees.map(user => <option key={user.id} value={user.id}>{user.full_name}</option>)}</optgroup>}{superAdminAssignees.length > 0 && <optgroup label="Super admin">{superAdminAssignees.map(user => <option key={user.id} value={user.id}>{user.full_name}</option>)}</optgroup>}</select></label>
          <label className="block text-sm">Due date<input className="field mt-2" name="dueDate" type="date" defaultValue={selectedTask.dueDate} disabled={busy} /></label>
        </div>
        <dl className="grid gap-2 border-t pt-3 text-xs sm:grid-cols-2"><div><dt className="text-slate-500">Created by</dt><dd className="mt-1 font-semibold">{selectedTask.createdBy.fullName}</dd></div><div><dt className="text-slate-500">Created</dt><dd className="mt-1 font-semibold">{new Date(selectedTask.createdAt).toLocaleString()}</dd></div></dl>
        {actionError && <p role="alert" className="text-sm text-rose-700">{actionError}</p>}
        <div className="flex justify-end gap-2"><button type="button" className="secondary-button" disabled={busy} onClick={() => setSelectedTask(null)}>Close</button><button className="primary-button" disabled={busy}>{busy ? 'Saving...' : 'Save changes'}</button></div>
      </form>
    </Modal>}
  </section>
}
