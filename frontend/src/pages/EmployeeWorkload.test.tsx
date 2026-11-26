import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmployeeWorkload } from './EmployeeWorkload'

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const ticket = {
  id: 'ticket-1',
  ticketNumber: 'IT-TKT-000101',
  employee: 'Requester',
  owner: 'IT Admin',
  ownerId: '11111111-1111-4111-8111-111111111111',
  category: 'Hardware',
  issue: 'Laptop battery replacement',
  status: 'Pending',
  createdAt: '2026-11-18T10:00:00Z',
  updatedAt: '2026-11-18T10:00:00Z',
  comments: [],
  notes: '',
}
const task = {
  id: '22222222-2222-4222-8222-222222222222',
  taskNumber: 'IT-TASK-000007',
  title: 'Prepare replacement laptop',
  description: 'Install the required software.',
  status: 'pending',
  priority: 'high',
  dueDate: '',
  createdAt: '2026-11-18T10:00:00Z',
  updatedAt: '2026-11-18T10:00:00Z',
  assignee: { id: '11111111-1111-4111-8111-111111111111', fullName: 'IT Admin' },
  createdBy: { id: '33333333-3333-4333-8333-333333333333', fullName: 'Administrator' },
}
const user = { id: '11111111-1111-4111-8111-111111111111', full_name: 'IT Admin', role: 'it_team' }
const superAdmin = { id: '44444444-4444-4444-8444-444444444444', full_name: 'Super Admin', role: 'super_admin' }
const employee = { id: '55555555-5555-4555-8555-555555555555', full_name: 'Employee User', role: 'employee' }

describe('Employee workload', () => {
  beforeEach(() => {
    localStorage.setItem('itms_token', 'fixture-token')
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === '/api/tasks') return json({ items: [task] })
      if (String(url) === '/api/users?status=active') return json({ items: [user] })
      return json([])
    }))
  })

  afterEach(() => { localStorage.clear(); vi.unstubAllGlobals() })

  it('groups tickets and tasks by assignee and opens their details', async () => {
    const onOpenTicket = vi.fn()
    render(<EmployeeWorkload tickets={[ticket]} ticketsReady onOpenTicket={onOpenTicket} />)

    const ticketCount = await screen.findByRole('button', { name: 'View 1 tickets for IT Admin' })
    expect(screen.getByRole('button', { name: 'View 1 tasks for IT Admin' })).toHaveTextContent('1')
    fireEvent.click(ticketCount)
    const ticketDialog = screen.getByRole('dialog', { name: 'Tickets · IT Admin' })
    fireEvent.click(within(ticketDialog).getByRole('button', { name: /Laptop battery replacement/ }))
    expect(onOpenTicket).toHaveBeenCalledWith(ticket)

    fireEvent.click(screen.getByRole('button', { name: 'View 1 tasks for IT Admin' }))
    const taskDialog = screen.getByRole('dialog', { name: 'Tasks · IT Admin' })
    fireEvent.click(within(taskDialog).getByRole('button', { name: /Prepare replacement laptop/ }))
    expect(screen.getByRole('dialog', { name: 'IT-TASK-000007 · Task details' })).toHaveTextContent('Install the required software.')
  })

  it('creates tasks and saves status and assignee changes', async () => {
    let taskStatus = 'pending'
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url) === '/api/tasks' && init?.method === 'POST') return json({ id: '44444444-4444-4444-8444-444444444444', taskNumber: 'IT-TASK-000008' }, 201)
      if (String(url).startsWith('/api/tasks/') && init?.method === 'PATCH') {
        taskStatus = JSON.parse(String(init.body)).status
        return json({ status: 'updated' })
      }
      if (String(url) === '/api/tasks') return json({ items: [{ ...task, status: taskStatus }] })
      if (String(url) === '/api/users?status=active') return json({ items: [user, superAdmin, employee] })
      return json([])
    })
    render(<EmployeeWorkload tickets={[]} ticketsReady onOpenTicket={vi.fn()} />)
    await screen.findByRole('button', { name: 'View 1 tasks for IT Admin' })

    fireEvent.click(screen.getByRole('button', { name: 'Create task' }))
    const createDialog = screen.getByRole('dialog', { name: 'Create task' })
    fireEvent.change(within(createDialog).getByLabelText('Task name'), { target: { value: 'Deploy laptop' } })
    const assignee = within(createDialog).getByLabelText(/Assign to IT team or super admin/)
    expect(within(assignee).getByRole('option', { name: 'IT Admin' })).toBeVisible()
    expect(within(assignee).getByRole('option', { name: 'Super Admin' })).toBeVisible()
    expect(within(assignee).queryByRole('option', { name: 'Employee User' })).not.toBeInTheDocument()
    fireEvent.change(assignee, { target: { value: user.id } })
    fireEvent.click(within(createDialog).getByRole('button', { name: 'Create task' }))
    expect(await screen.findByText('IT-TASK-000008 created and assigned.')).toBeVisible()

    fireEvent.click(await screen.findByRole('button', { name: 'Open details' }))
    const details = screen.getByRole('dialog', { name: 'IT-TASK-000007 · Task details' })
    fireEvent.change(within(details).getByLabelText('Status'), { target: { value: 'completed' } })
    fireEvent.click(within(details).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/tasks/${task.id}`, expect.objectContaining({ method: 'PATCH' })))
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => String(url) === `/api/tasks/${task.id}` && init?.method === 'PATCH')?.[1]?.body))).toEqual({ status: 'completed', dueDate: '' })
    expect(await screen.findByText('IT-TASK-000007 updated.')).toBeVisible()
    expect(await screen.findByText('Completed')).toBeVisible()
  })

  it('only offers IT team and super-admin users as task assignees', async () => {
    vi.mocked(fetch).mockImplementation(async url => String(url) === '/api/users?status=active' ? json({ items: [user, superAdmin, employee] }) : String(url) === '/api/tasks' ? json({ items: [] }) : json([]))
    render(<EmployeeWorkload tickets={[]} ticketsReady onOpenTicket={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create task' }))
    const dialog = screen.getByRole('dialog', { name: 'Create task' })
    const assignee = within(dialog).getByLabelText(/Assign to IT team or super admin/)
    expect(within(assignee).getAllByRole('option')).toHaveLength(3)
    expect(within(assignee).getByRole('option', { name: 'Super Admin' })).toBeVisible()
    expect(within(assignee).queryByRole('option', { name: 'Employee User' })).not.toBeInTheDocument()
  })

  it('explains why task creation is unavailable when no eligible assignee exists', async () => {
    vi.mocked(fetch).mockImplementation(async url => String(url) === '/api/users?status=active' ? json({ items: [employee] }) : json({ items: [] }))
    render(<EmployeeWorkload tickets={[]} ticketsReady onOpenTicket={vi.fn()} />)
    const createButton = await screen.findByRole('button', { name: 'Create task' })
    expect(createButton).toBeDisabled()
    expect(await screen.findByText(/No active IT team or super-admin users are available/)).toBeVisible()
  })

  it('does not present failed ticket or task requests as zero counts', async () => {
    vi.mocked(fetch).mockImplementation(async url => String(url) === '/api/tasks' ? json({ error: 'Tasks unavailable' }, 503) : json({ items: [user] }))
    render(<EmployeeWorkload tickets={[]} ticketsReady onOpenTicket={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Tasks unavailable')
    expect(screen.queryByText('No tasks created yet.')).not.toBeInTheDocument()
  })
})
