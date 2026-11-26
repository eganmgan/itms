import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmployeePage } from './EmployeePage'
import { warrantyNotice } from '../lib/warranty'
import * as exportHelpers from '../lib/exports'

vi.mock('react-chartjs-2', () => ({
  Bar: ({ data }: { data: unknown }) => <pre data-testid="items-chart">{JSON.stringify(data)}</pre>,
  Doughnut: ({ data }: { data: unknown }) => <pre data-testid="alerts-chart">{JSON.stringify(data)}</pre>,
}))

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const catalog = [{ id: 'keyboard-type', name: 'Keyboard' }, { id: 'laptop-type', name: 'Laptop' }, { id: 'mouse-type', name: 'Mouse' }, { id: 'headphone-type', name: 'Headphone' }]
const assigned = { devices: [{ id: 'my-laptop', name: 'Work laptop', assetTag: 'LAP-1' }], items: [{ id: 'my-keyboard', name: 'My keyboard', itemCode: 'KEY-1' }, { id: 'my-mouse', name: 'My mouse', itemCode: 'MOUSE-1' }] }
const requestRecord = { id: 'created-request', ticketNumber: 'DEMO-TKT-001001', type: 'software_installation', title: 'Install editor', description: 'Required for development', status: 'pending', notes: '', createdAt: '2026-10-08T10:00:00Z', updatedAt: '2026-10-08T10:00:00Z', requester: { id: 'employee', fullName: 'Employee fixture' }, assignee: { id: 'staff', fullName: 'IT Admin' }, comments: [] }

describe('Employee support actions', () => {
  beforeEach(() => {
    localStorage.setItem('itms_token', 'fixture-token')
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => json(String(url).endsWith('/me/requests/items') ? catalog : String(url).endsWith('/me/assets') ? assigned : String(url).includes('/users') ? { items: [], total: 0 } : [])))
  })
  afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState({}, '', '/') })

  it('uses only employee-scoped requests and hides staff management', async () => {
    render(<EmployeePage role="employee" />)
    await screen.findByText('Live API')
    expect(fetch).toHaveBeenCalledWith('/api/me/requests', expect.anything())
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('/api/requests'))).toBe(false)
    expect(screen.queryByRole('tab', { name: 'Employee Directory' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Employee Requests', 'IT Announcements'])
    expect(screen.queryByLabelText('Employee dashboard')).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'IT Announcements' }))
    expect(screen.queryByRole('button', { name: 'Publish Announcement' })).not.toBeInTheDocument()
  })

  it.each([['software_installation', 'Install new software'], ['laptop_replacement', 'Laptop replacement'], ['headphone_replacement', 'Headphone replacement'], ['mouse_replacement', 'Mouse replacement'], ['keyboard_replacement', 'Keyboard replacement'], ['manager_approval', 'Manager approval request'], ['other', 'Other IT support']])('submits %s to the staff workflow and shows saved history', async (type, title) => {
    let created = false
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).endsWith('/me/requests/items')) return json(catalog)
      if (String(url).endsWith('/me/assets')) return json(assigned)
      if (init?.method === 'POST') { created = true; return json(requestRecord, 201) }
      return json(String(url).endsWith('/me/requests') && created ? [{ ...requestRecord, type }] : [])
    })
    render(<EmployeePage role="employee" />)
    await screen.findByText('Live API')
    fireEvent.click(screen.getByRole('button', { name: 'Raise Request' }))
    const dialog = screen.getByRole('dialog', { name: 'Raise Request' })
    expect(within(dialog).getAllByRole('combobox')).toHaveLength(3)
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1)
    expect(within(dialog).queryByLabelText('Subject')).not.toBeInTheDocument()
    await screen.findByRole('option', { name: 'Keyboard replacement' })
    fireEvent.change(screen.getByLabelText('Asset'), { target: { value: 'my-keyboard' } })
    fireEvent.change(screen.getByLabelText('Request type'), { target: { value: type } })
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: requestRecord.description } })
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    expect(await screen.findByText(`Request ${requestRecord.ticketNumber} sent to the IT / Admin team.`)).toBeVisible()
    const history = await screen.findByRole('region', { name: 'Request history' })
    expect(await within(history).findByText(requestRecord.description)).toBeVisible()
    expect(history).toHaveTextContent('IT Admin')
    const writes = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(writes).toHaveLength(1)
    expect(writes[0][0]).toBe('/api/me/requests')
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual({ type, title: `${title} - My keyboard`, description: `Asset: My keyboard (KEY-1)\n\n${requestRecord.description}`, priority: 'medium' })
  })

  it('prevents duplicate sends and blocks automatic retry when submission is uncertain', async () => {
    let rejectSend!: (error: Error) => void
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((url, init) => init?.method === 'POST' ? new Promise<Response>((_resolve, reject) => { rejectSend = reject }) : original(url, init))
    render(<EmployeePage role="employee" />)
    await screen.findByText('Live API')
    fireEvent.click(screen.getByRole('button', { name: 'Raise Request' }))
    await screen.findByRole('option', { name: 'Mouse replacement' })
    fireEvent.change(screen.getByLabelText('Request type'), { target: { value: 'mouse_replacement' } })
    fireEvent.change(screen.getByLabelText('Asset'), { target: { value: 'my-mouse' } })
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Button broken' } })
    const form = screen.getByRole('button', { name: 'Send request' }).closest('form')!
    fireEvent.submit(form); fireEvent.submit(form)
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    await act(async () => rejectSend(new Error('Network disconnected')))
    expect(screen.getByRole('alert')).toHaveTextContent('Submission not confirmed')
    expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled()
    expect(screen.getByLabelText('Reason')).toHaveValue('Button broken')
  })

  it('aborts a pending submission when the account changes in another tab', async () => {
    let signal: AbortSignal | undefined
    let resolveSend!: (response: Response) => void
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((url, init) => {
      if (init?.method !== 'POST') return original(url, init)
      signal = init.signal ?? undefined
      return new Promise<Response>(resolve => { resolveSend = resolve })
    })
    render(<EmployeePage role="employee" />)
    await screen.findByText('Live API')
    fireEvent.click(screen.getByRole('button', { name: 'Raise Request' }))
    await screen.findByRole('option', { name: 'Laptop replacement' })
    fireEvent.change(screen.getByLabelText('Request type'), { target: { value: 'software_installation' } })
    fireEvent.change(screen.getByLabelText('Asset'), { target: { value: 'my-laptop' } })
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Development' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    act(() => { localStorage.removeItem('itms_token'); window.dispatchEvent(new StorageEvent('storage', { key: 'itms_token' })) })
    expect(signal?.aborted).toBe(true)
    await act(async () => resolveSend(json(requestRecord, 201)))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText(/sent to the IT \/ Admin team/)).not.toBeInTheDocument()
  })

  it('shows saved status, resolution notes and staff comments in history', async () => {
    vi.mocked(fetch).mockImplementation(async url => json(String(url).endsWith('/me/assets') ? { devices: [], items: [] } : String(url).endsWith('/me/requests') ? [{ ...requestRecord, status: 'resolved', notes: 'Software installed', comments: [{ id: 'comment', author: 'IT Admin', note: 'Installation scheduled', createdAt: requestRecord.createdAt }] }] : []))
    render(<EmployeePage role="employee" />)
    await screen.findByText('Live API')
    fireEvent.click(screen.getByRole('button', { name: 'Request history' }))
    const history = screen.getByRole('region', { name: 'Request history' })
    expect(history).toHaveTextContent('Resolved')
    expect(history).toHaveTextContent('Software installed')
    expect(history).toHaveTextContent('Installation scheduled')
  })

  it('shows device and accessory warranty notifications without replacement actions', async () => {
    const laptop = { id: 'laptop', name: 'Work laptop', assetTag: 'LAP-1', warrantyExpiresAt: '2020-01-01' }
    const mouse = { id: 'mouse', name: 'Assigned mouse', itemCode: 'MOUSE-1', warrantyExpiresAt: '2020-01-02' }
    vi.mocked(fetch).mockImplementation(async (url, init) => init?.method === 'POST' ? json(requestRecord, 201) : json(String(url).endsWith('/me/assets') ? { devices: [laptop], items: [mouse, { id: 'unknown', name: 'Unknown warranty' }] } : []))
    render(<EmployeePage role="employee" />)
    await screen.findByText('Live API')
    const notifications = screen.getByRole('region', { name: 'Warranty notifications' })
    expect(notifications).toHaveTextContent('Work laptop')
    expect(notifications).toHaveTextContent('Assigned mouse')
    expect(notifications).not.toHaveTextContent('Unknown warranty')
    expect(within(notifications).queryByRole('button')).not.toBeInTheDocument()
  })

  it('keeps request creation available when warranty data cannot load', async () => {
    vi.mocked(fetch).mockImplementation(async url => String(url).endsWith('/me/assets') ? json({}, 403) : json([]))
    render(<EmployeePage role="employee" />)
    await screen.findByText('Live API')
    expect(await screen.findByText('Assigned assets and warranty notifications unavailable.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Raise Request' })).toBeEnabled()
  })

  it('groups assigned equipment and catalog items in the asset list', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((url, init) => String(url).endsWith('/me/requests/items') ? Promise.resolve(json([...catalog, { id: 'projector-type', name: 'Projector' }])) : original(url, init))
    render(<EmployeePage role="employee" />)
    await screen.findByText('Live API')
    fireEvent.click(screen.getByRole('button', { name: 'Raise Request' }))
    await screen.findByRole('option', { name: 'Projector replacement' })
    const assetSelect = within(screen.getByLabelText('Asset'))
    expect(within(assetSelect.getByRole('group', { name: 'Assigned equipment' })).getAllByRole('option').map(option => option.textContent)).toEqual(['Work laptop - LAP-1', 'My keyboard - KEY-1', 'My mouse - MOUSE-1'])
    expect(within(assetSelect.getByRole('group', { name: 'Catalog items' })).getAllByRole('option').map(option => option.textContent)).toEqual(['Keyboard', 'Laptop', 'Mouse', 'Headphone', 'Projector'])
    expect(fetch).toHaveBeenCalledWith('/api/me/requests/items', expect.objectContaining({ cache: 'no-store' }))
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === '/api/items')).toBe(false)
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Need a projector' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Send request' }).closest('form')!)
    expect(screen.getByRole('alert')).toHaveTextContent('Select an asset from the list.')
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('retries a failed catalog load without losing the entered reason', async () => {
    let attempts = 0
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((url, init) => String(url).endsWith('/me/requests/items') ? Promise.resolve(++attempts === 1 ? json({}, 503) : json(catalog)) : original(url, init))
    render(<EmployeePage role="employee" />)
    await screen.findByText('Live API')
    fireEvent.click(screen.getByRole('button', { name: 'Raise Request' }))
    await screen.findByText('Asset list unavailable. Try again.')
    expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Keyboard replacement needed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Retry asset list' }))
    await screen.findByRole('option', { name: 'Keyboard replacement' })
    expect(screen.getByLabelText('Reason')).toHaveValue('Keyboard replacement needed')
    expect(screen.getByRole('button', { name: 'Send request' })).toBeEnabled()
  })

  it('submits a catalog item when no equipment is assigned', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((url, init) => init?.method === 'POST' ? Promise.resolve(json(requestRecord, 201)) : String(url).endsWith('/me/assets') ? Promise.resolve(json({ devices: [], items: [] })) : original(url, init))
    render(<EmployeePage role="employee" />)
    await screen.findByText('Live API')
    fireEvent.click(screen.getByRole('button', { name: 'Raise Request' }))
    await screen.findByRole('option', { name: 'Keyboard' })
    expect(screen.queryByRole('group', { name: 'Assigned equipment' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Request type'), { target: { value: 'other' } })
    fireEvent.change(screen.getByLabelText('Asset'), { target: { value: 'catalog:keyboard-type' } })
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Need a keyboard' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }))
    expect(await screen.findByText(`Request ${requestRecord.ticketNumber} sent to the IT / Admin team.`)).toBeVisible()
    const writes = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(writes).toHaveLength(1)
    expect(JSON.parse(String(writes[0][1]?.body))).toEqual({ type: 'other', title: 'Other IT support - Keyboard', description: 'Asset: Keyboard (catalog item)\n\nNeed a keyboard', priority: 'medium' })
  })

  it('disables submission when both assigned equipment and catalog are empty', async () => {
    vi.mocked(fetch).mockImplementation(async url => json(String(url).endsWith('/me/assets') ? { devices: [], items: [] } : []))
    render(<EmployeePage role="employee" />)
    await screen.findByText('Live API')
    fireEvent.click(screen.getByRole('button', { name: 'Raise Request' }))
    await screen.findByText('No assigned equipment or catalog items available.')
    expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled()
    expect(within(screen.getByLabelText('Asset')).queryByRole('option', { name: 'Laptop' })).not.toBeInTheDocument()
  })

  it('aborts a pending catalog read and ignores its response after sign-out', async () => {
    let resolveCatalog!: (response: Response) => void
    let signal: AbortSignal | undefined
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((url, init) => {
      if (!String(url).endsWith('/me/requests/items')) return original(url, init)
      signal = init?.signal ?? undefined
      return new Promise<Response>(resolve => { resolveCatalog = resolve })
    })
    render(<EmployeePage role="employee" />)
    await screen.findByText('Live API')
    fireEvent.click(screen.getByRole('button', { name: 'Raise Request' }))
    expect(screen.getByRole('button', { name: 'Send request' })).toBeDisabled()
    act(() => { localStorage.removeItem('itms_token'); window.dispatchEvent(new Event('itms-auth-changed')) })
    expect(signal?.aborted).toBe(true)
    await act(async () => resolveCatalog(json(catalog)))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Keyboard' })).not.toBeInTheDocument()
  })

  it('does not offer employee request creation to an auditor', async () => {
    render(<EmployeePage role="auditor" />)
    await screen.findByText('Live API')
    expect(screen.queryByRole('button', { name: 'Raise Request' })).not.toBeInTheDocument()
  })

  it('shows assigned items, accurate charts and detailed alerts on the dashboard', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((url, init) => String(url).endsWith('/me/alerts') ? Promise.resolve(json([{ id: 'alert', title: 'Malware detected', detail: 'Suspicious file quarantined', severity: 'high', sourceLabel: 'ClamAV', hostname: 'Work laptop', resolved: false }])) : original(url, init))
    render(<EmployeePage role="employee" dashboard />)
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    await screen.findByText('Malware detected')
    expect(screen.getByRole('region', { name: 'Current items' })).toHaveTextContent('LAP-1')
    expect(screen.getByTestId('items-chart')).toHaveTextContent('"data":[3]')
    expect(screen.getByTestId('alerts-chart')).toHaveTextContent('"data":[0,1,0,0,0]')
    expect(screen.getByText('Suspicious file quarantined')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Send to IT: Malware detected' })).toBeEnabled()
  })

  it('shows unavailable alerts rather than a zero chart when dashboard reads fail', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((url, init) => String(url).endsWith('/me/alerts') ? Promise.resolve(json({}, 403)) : original(url, init))
    render(<EmployeePage role="employee" dashboard />)
    await screen.findByText('Security alerts unavailable. Refresh to try again.')
    expect(screen.queryByTestId('alerts-chart')).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Current items' })).toHaveTextContent('My mouse')
  })

  it.each(['loading', 'failed', 'signed out'])('does not substitute sample employee records when %s', async state => {
    if (state === 'signed out') localStorage.clear()
    vi.mocked(fetch).mockImplementation(() => state === 'loading' ? new Promise<Response>(() => {}) : Promise.resolve(new Response(JSON.stringify({ error: 'Employee data unavailable' }), { status: 503 })))
    render(<EmployeePage />)
    if (state !== 'loading') await screen.findByRole('alert')
    expect(screen.queryByText('Demo data')).not.toBeInTheDocument()
    expect(screen.queryByText('REQ-1048')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'IT Announcements' }))
    expect(screen.queryByText('Planned network maintenance', { exact: false })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Publish Announcement' })).toBeDisabled()
    fireEvent.click(screen.getByRole('tab', { name: 'Reports & Export' }))
    expect(screen.queryByText('REQ-1048')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'CSV' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'PDF' })).toBeDisabled()
    if (state === 'signed out') expect(fetch).not.toHaveBeenCalled()
  })

  it('displays company ticket numbers but mutates using the internal request ID', async () => {
    const request = { id: 'request-uuid', ticketNumber: 'ZTECH-TKT-001001', type: 'hardware', title: 'Repair', description: 'Broken display', status: 'pending', createdAt: '2026-09-23T10:00:00Z', updatedAt: '2026-09-23T10:00:00Z', requester: { id: 'person', fullName: 'Employee fixture' }, assignee: { id: null, fullName: '' }, comments: [] }
    vi.mocked(fetch).mockImplementation(async (url, init) => new Response(JSON.stringify(init?.method === 'PUT' ? {} : String(url) === '/api/requests' ? [request] : []), { status: 200 }))
    render(<EmployeePage />)
    await screen.findByText('Live API')
    fireEvent.change(screen.getByLabelText('Search all requests'), { target: { value: request.ticketNumber } })
    expect(await screen.findByText(request.ticketNumber)).toBeVisible()
    expect(screen.queryByText(request.id)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/requests/request-uuid/status', expect.objectContaining({ method: 'PUT' })))
    expect(await screen.findByText(`${request.ticketNumber} approved.`)).toBeVisible()
  })

  it('shows today’s tickets by default and finds older tickets by search', async () => {
    const today = { ...requestRecord, id: 'today', ticketNumber: 'TODAY-1', createdAt: new Date().toISOString() }
    const earlier = { ...requestRecord, id: 'old', ticketNumber: 'OLD-1', createdAt: '2020-01-01T00:00:00Z' }
    vi.mocked(fetch).mockImplementation(async url => json(String(url) === '/api/requests' ? [today, earlier] : []))
    render(<EmployeePage />)
    expect(await screen.findByText('TODAY-1')).toBeVisible()
    expect(screen.queryByText('OLD-1')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Search all requests'), { target: { value: 'OLD-1' } })
    expect(screen.getByText('OLD-1')).toBeVisible()
    expect(screen.queryByText('TODAY-1')).not.toBeInTheDocument()
  })

  it('ignores late employee data after sign-out', async () => {
    let resolveRequests!: (response: Response) => void
    let signal: AbortSignal | undefined
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url) === '/api/requests') {
        signal = init?.signal ?? undefined
        return new Promise<Response>(resolve => { resolveRequests = resolve })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    })
    render(<EmployeePage />)
    act(() => { localStorage.removeItem('itms_token'); window.dispatchEvent(new Event('itms-auth-changed')) })
    expect(signal?.aborted).toBe(true)
    await act(async () => { resolveRequests(new Response(JSON.stringify([{ id: 'old-ticket', requester: { fullName: 'Previous employee' }, assignee: { fullName: '' }, type: 'hardware', status: 'pending', comments: [] }]), { status: 200 })) })
    expect(screen.queryByText('Previous employee')).not.toBeInTheDocument()
    expect(screen.queryByText('Live API')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in to load employee data.')
  })

  it('shows Add User only in Employee Directory and keeps the directory and other tabs', async () => {
    render(<EmployeePage />)
    await screen.findByText('Live API')
    expect(screen.queryByRole('button', { name: 'Add User' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Employee Directory' }))
    expect(await screen.findByPlaceholderText('Search name, email, ID, department or role')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Add User' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add User' }))
    expect(screen.getByRole('dialog', { name: 'Add user manually' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    for (const tab of ['Employee Requests', 'IT Announcements', 'Reports & Export']) {
      fireEvent.click(screen.getByRole('tab', { name: tab }))
      expect(screen.queryByRole('button', { name: 'Add User' })).not.toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('tab', { name: 'IT Announcements' }))
    expect(screen.getByRole('button', { name: 'Publish Announcement' })).toBeVisible()
  })

  it('opens the Reports page from the Employee workspace navigation', async () => {
    const request = { ...requestRecord, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    const exportPdf = vi.spyOn(exportHelpers, 'exportElementPdf').mockResolvedValue()
    vi.mocked(fetch).mockImplementation(async url => json(String(url) === '/api/requests' ? [request] : []))
    render(<EmployeePage role="admin" />)
    await screen.findByText('Live API')

    fireEvent.click(screen.getByRole('button', { name: 'Reports' }))

    expect(await screen.findByRole('region', { name: 'Employee activity report' })).toBeVisible()
    expect(screen.getByText('Employee support activity')).toBeVisible()
    expect(screen.getByText(request.ticketNumber)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'PDF' }))
    await waitFor(() => expect(exportPdf).toHaveBeenCalledWith(expect.any(HTMLElement), 'employee-support-logs.pdf', { orientation: 'landscape' }))
  })

  it('places admin workload counts inside Employee', async () => {
    vi.mocked(fetch).mockImplementation(async url => {
      if (String(url) === '/api/tasks') return json({ items: [] })
      if (String(url) === '/api/users?status=active') return json({ items: [] })
      return json([])
    })
    render(<EmployeePage role="admin" canManageWorkload />)
    await screen.findByText('Live API')
    fireEvent.click(screen.getByRole('tab', { name: 'Admin counts' }))
    expect(await screen.findByRole('region', { name: 'Admin counts and workload' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Task list' })).toHaveTextContent('No tasks created yet.')
  })
})

describe('warranty notification dates', () => {
  const today = new Date('2026-10-08T23:59:00Z')
  it.each([
    ['2026-10-07', 'Warranty expired on 2026-10-07'],
    ['2026-10-08', 'Warranty expires today'],
    ['2026-10-09', 'Warranty expires in 1 day (2026-10-09)'],
    ['2026-11-07', 'Warranty expires in 30 days (2026-11-07)'],
    ['2026-11-08', null], ['2026-02-30', null], ['invalid', null], ['', null], [null, null],
  ])('classifies %s', (expiry, expected) => expect(warrantyNotice(expiry, today)).toBe(expected))
})