import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SupportChat } from './SupportChat'
import { ChatAssistant } from './ChatAssistant'

const channel = { id: 'channel-1', name: 'software issue', status: 'open', primaryOwner: { id: 'gani', fullName: 'Muhammed Gani' }, createdBy: { id: 'employee', fullName: 'Test Employee' } }
const message = { id: 'message-1', body: 'Hi, Muhammed Gani from the IT team here.', createdAt: '2026-09-30T12:00:00Z', author: { id: 'gani', fullName: 'Muhammed Gani' } }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
function setup(role = 'employee') {
  let created = false
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === '/api/auth/me') return json({ id: role === 'employee' ? 'employee' : 'gani', full_name: role === 'employee' ? 'Test Employee' : 'Muhammed Gani', role })
    if (path === '/api/chat/support-options') return json({ subjects: ['software installation', 'laptop issue', 'software issue'], allowNewChats: true })
    if (path === '/api/chat/support-queue') return json({ items: [] })
    if (path === '/api/chat/presence/agents') return json({ items: [{ id: 'agent-2', fullName: 'Alex Technician' }] })
    if (path === '/api/chat/presence') return json({ available: JSON.parse(String(init?.body)).available })
    if (path === '/api/integrations/mattermost/messages?limit=100') return json({ items: [{ postId: 'post-123', channelName: 'town-square', userName: 'egan', message: 'Hello from Mattermost', postedAt: '2026-11-18T10:00:00Z' }] })
    if (path === '/api/chat/channels' && init?.method === 'POST') { created = true; return json({ id: channel.id }, 201) }
    if (path.startsWith('/api/chat/channels?')) return json({ items: created ? [channel] : [], total: created ? 1 : 0 })
    if (path.includes('/messages?')) return json({ items: [{ ...message, author: role !== 'employee' && new URL(path, 'http://localhost').searchParams.get('pageSize') === '1' ? { id: 'employee', fullName: 'Test Employee' } : message.author }], total: 1 })
    if (path.endsWith('/messages') && init?.method === 'POST') return json({ ...message, author: { id: 'employee', fullName: 'Test Employee' } }, 201)
    throw new Error(`Unexpected test request ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('itms_token', 'support-test')
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('IT support chat', () => {
  it('keeps Mattermost in the assistant-level service tabs, not inside ITMS Support', async () => {
    setup()
    render(<SupportChat token="support-test" />)

    expect(await screen.findByText('No chats yet.')).toBeVisible()
    expect(screen.queryByRole('tab', { name: 'Mattermost' })).not.toBeInTheDocument()
  })

  it('shares presence heartbeats between assistant instances', async () => {
    vi.useFakeTimers()
    const fetchMock = setup('it_team')
    render(<><ChatAssistant context="Devices" /><ChatAssistant context="Employee" /></>)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/chat/presence')).toHaveLength(1)
  })

  it('does not mark a user offline just because a tab is hidden', async () => {
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const fetchMock = setup('it_team')
    render(<ChatAssistant context="Devices" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const presenceCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) === '/api/chat/presence')
    expect(presenceCalls()).toHaveLength(0)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    fireEvent(document, new Event('visibilitychange'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(presenceCalls()).toHaveLength(1)
  })

  it('uses the bottom plus to start a new chat even when the current chat is closed', async () => {
    const fetchMock = setup('it_team')
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      const path = String(url)
      if (path.startsWith('/api/chat/channels?')) return json({ items: [{ ...channel, status: 'closed' }], total: 1 })
      if (path === '/api/chat/participants?page=1') return json({ items: [{ id: 'alex', fullName: 'Alex Example', isMember: false }], hasMore: false })
      return handler(url, init)
    })
    render(<SupportChat token="support-test" />)
    expect(await screen.findByText('This chat is closed.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Start new chat' }))
    const picker = screen.getByRole('region', { name: 'Add person to chat' })
    fireEvent.click(await within(picker).findByRole('button', { name: 'Alex Example' }))
    expect(screen.getByText('New chat with Alex Example')).toBeVisible()
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/channels/channel-1/participants') || (String(url).endsWith('/participants') && init?.method === 'POST'))).toBe(false)
  })

  it('starts a new chat from the composer without sending the old draft', async () => {
    const fetchMock = setup()
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      const path = String(url)
      if (path.startsWith('/api/chat/channels?')) return json({ items: [channel], total: 1 })
      if (path === '/api/chat/participants?page=1') return json({ items: [{ id: 'alex', fullName: 'Alex Example', isMember: false }], hasMore: false })
      return handler(url, init)
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<SupportChat token="support-test" />)
    expect(await screen.findByText(message.body)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Old draft' } })
    const start = await screen.findByRole('button', { name: 'Start new chat' })
    await waitFor(() => expect(start).toBeEnabled())
    fireEvent.click(start)
    expect(screen.getByLabelText('Message')).toHaveValue('Old draft')
    confirm.mockReturnValue(true)
    fireEvent.click(start)
    const picker = screen.getByRole('region', { name: 'Add person to chat' })
    fireEvent.click(await within(picker).findByRole('button', { name: 'Alex Example' }))
    expect(screen.getByLabelText('Message')).toHaveValue('')
    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/chat/channels' && init?.method === 'POST')).toBe(false)
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'New message' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/channels', expect.objectContaining({ body: JSON.stringify({ name: 'General support', kind: 'support', initialMessage: 'New message', supportParticipantIds: ['alex'] }) })))
  })

  it('loads more users on scroll and discards stale searches', async () => {
    const fetchMock = setup()
    const handler = fetchMock.getMockImplementation()!
    let resolveOld!: (response: Response) => void
    fetchMock.mockImplementation(async (url, init) => {
      const path = String(url)
      if (path.startsWith('/api/chat/channels?')) return json({ items: [channel], total: 1 })
      if (path === '/api/chat/participants?page=1') return json({ items: [{ id: 'one', fullName: 'First User', isMember: false }], hasMore: true })
      if (path === '/api/chat/participants?page=2') return json({ items: [{ id: 'two', fullName: 'Second User', isMember: false }], hasMore: false })
      if (path === '/api/chat/participants?page=1&search=old') return new Promise<Response>(resolve => { resolveOld = resolve })
      if (path === '/api/chat/participants?page=1&search=alex') return json({ items: [{ id: 'alex', fullName: 'Alex Example', isMember: false }], hasMore: false })
      if (path === '/api/chat/participants?page=1&search=missing') return json({ items: [], hasMore: false })
      return handler(url, init)
    })
    render(<SupportChat token="support-test" />)
    const add = await screen.findByRole('button', { name: 'Start new chat' })
    await waitFor(() => expect(add).toBeEnabled())
    fireEvent.click(add)
    const dialog = screen.getByRole('region', { name: 'Add person to chat' })
    await within(dialog).findByRole('button', { name: 'First User' })
    const results = within(dialog).getByRole('region', { name: 'User search results' })
    fireEvent.scroll(results)
    expect(await within(dialog).findByRole('button', { name: 'Second User' })).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'First User' })).toBeVisible()
    const input = within(dialog).getByRole('searchbox', { name: 'Search users' })
    fireEvent.change(input, { target: { value: 'old' } })
    expect(within(dialog).queryByRole('button', { name: 'Second User' })).not.toBeInTheDocument()
    await waitFor(() => expect(resolveOld).toBeDefined())
    fireEvent.change(input, { target: { value: 'alex' } })
    expect(await within(dialog).findByRole('button', { name: 'Alex Example' })).toBeVisible()
    await act(async () => { resolveOld(json({ items: [{ id: 'old', fullName: 'Old Result', isMember: false }], hasMore: false })) })
    expect(within(dialog).queryByRole('button', { name: 'Old Result' })).not.toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'missing' } })
    expect(await within(dialog).findByText('No matching authorized users.')).toBeVisible()
    expect(within(dialog).queryByRole('button', { name: 'Alex Example' })).not.toBeInTheDocument()
  })

  it('searches new-chat users and allows retry after a search error', async () => {
    const fetchMock = setup()
    const handler = fetchMock.getMockImplementation()!
    let attempts = 0
    fetchMock.mockImplementation(async (url, init) => {
      const path = String(url)
      if (path.startsWith('/api/chat/channels?')) return json({ items: [channel], total: 1 })
      if (path === '/api/chat/participants?page=1') return json({ items: [], hasMore: false })
      if (path === '/api/chat/participants?page=1&search=alex') {
        attempts++
        return attempts === 1 ? json({}, 500) : json({ items: [{ id: 'alex', fullName: 'Alex Example', isMember: false }], hasMore: false })
      }
      if (path.endsWith('/participants') && init?.method === 'POST') return json({ added: 1 })
      return handler(url, init)
    })
    render(<SupportChat token="support-test" />)
    const add = await screen.findByRole('button', { name: 'Start new chat' })
    await waitFor(() => expect(add).toBeEnabled())
    fireEvent.click(add)
    const dialog = screen.getByRole('region', { name: 'Add person to chat' })
    fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Search users' }), { target: { value: 'alex' } })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Retry loading users' }))
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Alex Example' }))
    expect(screen.getByText('New chat with Alex Example')).toBeVisible()
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/participants') && init?.method === 'POST')).toBe(false)
  })

  it.each([
    { role: 'employee', status: 'closed', action: 'Reopen' },
    { role: 'it_team', status: 'open', action: 'Close' },
  ])('opens the latest $status chat with its $action action for $role', async ({ role, status, action }) => {
    const fetchMock = setup(role)
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => String(url).startsWith('/api/chat/channels?')
      ? json({ items: [{ ...channel, status }, { ...channel, id: 'older', name: 'Older issue', status: 'open' }], total: 2 })
      : handler(url, init))
    render(<SupportChat token="support-test" />)
    const actions = await screen.findByRole('group', { name: 'Chat actions' })
    expect(within(actions).getByRole('button', { name: action })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'software issue' })).toBeVisible()
    expect(within(actions).queryByRole('button', { name: status === 'closed' ? 'Close' : 'Reopen' })).not.toBeInTheDocument()
    if (role === 'it_team' && status === 'open') expect(within(actions).getByRole('button', { name: 'Approval' })).toBeVisible()
    else expect(within(actions).queryByRole('button', { name: 'Approval' })).not.toBeInTheDocument()
  })

  it('updates bottom actions for the conversation the user selects', async () => {
    const fetchMock = setup('it_team')
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => String(url).startsWith('/api/chat/channels?')
      ? json({ items: [channel, { ...channel, id: 'closed', name: 'Printer', status: 'closed' }], total: 2 })
      : handler(url, init))
    render(<SupportChat token="support-test" />)
    expect(within(await screen.findByRole('group', { name: 'Chat actions' })).getByRole('button', { name: 'Close' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Printer.*Muhammed Gani/ }))
    const actions = screen.getByRole('group', { name: 'Chat actions' })
    expect(within(actions).getByRole('button', { name: 'Reopen' })).toBeVisible()
    expect(within(actions).queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    expect(within(actions).getByRole('button', { name: 'Approval' })).toBeVisible()
  })

  it('handles an agent going offline before assignment', async () => {
    const fetchMock = setup('it_team')
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      const path = String(url)
      if (path.startsWith('/api/chat/channels?')) return json({ items: [channel], total: 1 })
      if (path.endsWith('/transfer') && init?.method === 'PUT') return json({ error: 'offline' }, 409)
      return handler(url, init)
    })
    render(<SupportChat token="support-test" />)
    fireEvent.click(within(await screen.findByRole('group', { name: 'Chat actions' })).getByRole('button', { name: 'Assign' }))
    const dialog = screen.getByRole('dialog', { name: 'Assign chat' })
    await within(dialog).findByRole('option', { name: 'Alex Technician' })
    fireEvent.change(within(dialog).getByLabelText('Online IT team member'), { target: { value: 'agent-2' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign chat' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Chat or team availability changed')
  })

  it('reports when no other IT team member is online', async () => {
    const fetchMock = setup('it_team')
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).startsWith('/api/chat/channels?')) return json({ items: [channel], total: 1 })
      if (String(url) === '/api/chat/presence/agents') return json({ items: [] })
      return handler(url, init)
    })
    render(<SupportChat token="support-test" />)
    fireEvent.click(within(await screen.findByRole('group', { name: 'Chat actions' })).getByRole('button', { name: 'Assign' }))
    const dialog = screen.getByRole('dialog', { name: 'Assign chat' })
    expect(await within(dialog).findByText('No other IT team members are online.')).toBeVisible()
    expect(within(dialog).getByRole('button', { name: 'Assign chat' })).toBeDisabled()
  })

  it('submits the chosen teammate', async () => {
    const fetchMock = setup('it_team')
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      const path = String(url)
      if (path.startsWith('/api/chat/channels?')) return json({ items: [channel], total: 1 })
      if (path.endsWith('/transfer') && init?.method === 'PUT') return json({ ownerId: 'agent-2' })
      return handler(url, init)
    })
    render(<SupportChat token="support-test" />)
    const actions = await screen.findByRole('group', { name: 'Chat actions' })
    fireEvent.click(within(actions).getByRole('button', { name: 'Assign' }))
    const dialog = screen.getByRole('dialog', { name: 'Assign chat' })
    await within(dialog).findByRole('option', { name: 'Alex Technician' })
    fireEvent.change(within(dialog).getByLabelText('Online IT team member'), { target: { value: 'agent-2' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Assign chat' }))
    expect(await screen.findByText('Chat reassigned to the selected IT team member.')).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/channels/channel-1/transfer', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ ownerId: 'agent-2' }) }))
  })

  it.each(['employee', 'it_team', 'super_admin', 'admin'])('shows only recent chats in the sidebar for %s', async role => {
    const fetchMock = setup(role)
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => String(url).startsWith('/api/chat/channels?')
      ? json({ items: [channel, { id: 'waiting', name: 'Printer', status: 'open' }], total: 2 })
      : handler(url, init))
    render(<SupportChat token="support-test" />)
    expect(await screen.findByRole('heading', { name: 'Recent chats' })).toBeVisible()
    expect(await screen.findByRole('button', { name: /software issue.*Muhammed Gani/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /Printer.*Waiting for IT team/ })).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Assignment status' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'IT team online' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Take chat/ })).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => ['/api/chat/support-queue', '/api/chat/presence/agents'].includes(String(url)))).toBe(false)
    expect(screen.queryByRole('button', { name: 'New support chat' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start new chat' })).toBeEnabled()
  })

  it.each([
    ['employee', 'Muhammed Gani', 'Test Employee'],
    ['it_team', 'Test Employee', 'Muhammed Gani'],
  ])('shows the other participant in recent chats for %s', async (role, other, self) => {
    const fetchMock = setup(role)
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => String(url).startsWith('/api/chat/channels?')
      ? json({ items: [{ ...channel, name: 'General support', members: [channel.createdBy, channel.primaryOwner] }], total: 1 })
      : handler(url, init))
    render(<SupportChat token="support-test" />)
    const list = (await screen.findByRole('heading', { name: 'Recent chats' })).closest('aside')!
    const conversation = await within(list).findByRole('button', { name: new RegExp(other) })
    expect(within(conversation).getByText(other, { selector: 'strong' })).toBeVisible()
    expect(within(conversation).queryByText(self, { selector: 'strong' })).not.toBeInTheDocument()
  })

  it('lists other participants in group chats and handles an empty conversation', async () => {
    const fetchMock = setup()
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => String(url).startsWith('/api/chat/channels?')
      ? json({ items: [
        { ...channel, name: 'Chat', members: [channel.createdBy, channel.primaryOwner, { id: 'alex', fullName: 'Alex Example' }] },
        { ...channel, id: 'empty', name: 'Chat', primaryOwner: undefined, members: [channel.createdBy] },
      ], total: 2 })
      : handler(url, init))
    render(<SupportChat token="support-test" />)
    const list = (await screen.findByRole('heading', { name: 'Recent chats' })).closest('aside')!
    expect(within(list).getByText('Muhammed Gani, Alex Example', { selector: 'strong' })).toBeVisible()
    expect(within(list).getByText('No other participants', { selector: 'strong' })).toBeVisible()
  })

  it('lets an employee retry a failed connection without reopening chat', async () => {
    const fetchMock = setup()
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementationOnce(async () => json({}, 503))
    render(<SupportChat token="support-test" />)
    await screen.findByRole('alert')
    fetchMock.mockImplementation(handler)
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }))
    await screen.findByText('Select an existing conversation or use + to start a chat.')
    expect(screen.queryByRole('checkbox', { name: 'Available for chats' })).not.toBeInTheDocument()
  })

  it('times out a stalled employee connection and makes retry available', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))))
    render(<SupportChat token="support-test" />)
    expect(screen.getByRole('status')).toHaveTextContent('Connecting')
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(screen.getByRole('alert')).toHaveTextContent('timed out')
    expect(screen.getByRole('button', { name: 'Retry connection' })).toBeEnabled()
  })

  it('opens chats by default without fetching AI guidance', async () => {
    const fetchMock = setup()
    render(<ChatAssistant context="Devices" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open ITMS assistant' }))
    expect(await screen.findByText('No chats yet.')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Chat' })).toBeVisible()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/chat/ai/'))).toBe(false)
  })

  it('browses chat history without a search box', async () => {
    const fetchMock = setup()
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => String(url).startsWith('/api/chat/channels?')
      ? json({ items: [channel], total: 1 })
      : handler(url, init))
    render(<ChatAssistant context="Devices" token="support-test" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open ITMS assistant' }))
    expect(await screen.findByRole('button', { name: /software issue.*Muhammed Gani/ })).toBeVisible()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('created_today=true'))).toBe(true)
    expect(screen.queryByRole('searchbox', { name: 'Search chats' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show chat history' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes('history=true') && !String(url).includes('created_today=true'))).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: "Show today's chats" }))
    expect(screen.getByRole('button', { name: 'Show chat history' })).toBeVisible()
  })

  it('lets IT close a chat and shows the linked ticket number', async () => {
    const fetchMock = setup('it_team')
    const handler = fetchMock.getMockImplementation()!
    let status = 'open'
    fetchMock.mockImplementation(async (url, init) => {
      const path = String(url)
      if (path.startsWith('/api/chat/channels?')) return json({ items: [{ ...channel, status }], total: 1 })
      if (path.endsWith('/close') && init?.method === 'PUT') {
        status = 'closed'
        return json({ status, ticketNumber: 'IT-TKT-42' })
      }
      return handler(url, init)
    })
    render(<SupportChat token="support-test" />)
    fireEvent.click(await screen.findByRole('button', { name: /software issue.*Muhammed Gani/ }))
    const actions = screen.getByRole('group', { name: 'Chat actions' })
    expect(within(actions).getByRole('button', { name: 'Approval' })).toBeVisible()
    fireEvent.click(within(actions).getByRole('button', { name: 'Close' }))
    expect(await screen.findByText(/Chat closed\. Ticket IT-TKT-42/)).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/channels/channel-1/close', expect.objectContaining({ method: 'PUT' }))
    expect(within(screen.getByRole('group', { name: 'Chat actions' })).getByRole('button', { name: 'Reopen' })).toBeVisible()
  })

  it('lets an employee close their own chat', async () => {
    const fetchMock = setup()
    const handler = fetchMock.getMockImplementation()!
    let status = 'open'
    fetchMock.mockImplementation(async (url, init) => {
      const path = String(url)
      if (path.startsWith('/api/chat/channels?')) return json({ items: [{ ...channel, status }], total: 1 })
      if (path.endsWith('/close') && init?.method === 'PUT') {
        status = 'closed'
        return json({ status, ticketNumber: 'IT-TKT-44' })
      }
      return handler(url, init)
    })
    render(<SupportChat token="support-test" />)
    fireEvent.click(await screen.findByRole('button', { name: /software issue.*Muhammed Gani/ }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Chat actions' })).getByRole('button', { name: 'Close' }))
    expect(await screen.findByText(/Chat closed\. Ticket IT-TKT-44/)).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/channels/channel-1/close', expect.objectContaining({ method: 'PUT' }))
  })

  it('lets an employee reopen the same closed chat', async () => {
    const fetchMock = setup()
    const handler = fetchMock.getMockImplementation()!
    let status = 'closed'
    fetchMock.mockImplementation(async (url, init) => {
      const path = String(url)
      if (path.startsWith('/api/chat/channels?')) return json({ items: [{ ...channel, status }], total: 1 })
      if (path.endsWith('/reopen') && init?.method === 'PUT') {
        status = 'open'
        return json({ status })
      }
      return handler(url, init)
    })
    render(<SupportChat token="support-test" />)
    fireEvent.click(await screen.findByRole('button', { name: /software issue.*Muhammed Gani/ }))
    expect(await screen.findByText('This chat is closed.')).toBeVisible()
    fireEvent.click(within(screen.getByRole('group', { name: 'Chat actions' })).getByRole('button', { name: 'Reopen' }))
    expect(await screen.findByText(/Chat reopened with the same issue/)).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/channels/channel-1/reopen', expect.objectContaining({ method: 'PUT' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled())
  })

  it('shows reopen only in the selected chat actions', async () => {
    const fetchMock = setup()
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      const path = String(url)
      if (path.startsWith('/api/chat/channels?')) return json({ items: [{ ...channel, status: 'closed' }], total: 1 })
      return handler(url, init)
    })
    render(<SupportChat token="support-test" />)
    const actions = await screen.findByRole('group', { name: 'Chat actions' })
    expect(within(actions).getByRole('button', { name: 'Reopen' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Reopen software issue' })).not.toBeInTheDocument()
  })

  it('shows close and approval actions at the bottom of an open chat', async () => {
    const fetchMock = setup('it_team')
    const handler = fetchMock.getMockImplementation()!
    let status = 'open'
    fetchMock.mockImplementation(async (url, init) => {
      const path = String(url)
      if (path.startsWith('/api/chat/channels?')) return json({ items: [{ ...channel, status }], total: 1 })
      if (path.endsWith('/close') && init?.method === 'PUT') { status = 'closed'; return json({ status, ticketNumber: 'IT-TKT-45' }) }
      return handler(url, init)
    })
    render(<SupportChat token="support-test" />)
    fireEvent.click(await screen.findByRole('button', { name: /software issue.*Muhammed Gani/ }))
    const actions = screen.getByRole('group', { name: 'Chat actions' })
    expect(within(actions).getByRole('button', { name: 'Approval' })).toBeVisible()
    fireEvent.click(within(actions).getByRole('button', { name: 'Close' }))
    expect(await screen.findByText(/Chat closed\. Ticket IT-TKT-45/)).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/channels/channel-1/close', expect.objectContaining({ method: 'PUT' }))
    expect(within(await screen.findByRole('group', { name: 'Chat actions' })).getByRole('button', { name: 'Reopen' })).toBeVisible()
  })

  it.each(['open', 'closed'])('submits a manager approval request from an %s IT team chat', async status => {
    const fetchMock = setup('it_team')
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url) === '/api/me/requests' && init?.method === 'POST') return json({ id: 'approval-1', ticketNumber: 'IT-TKT-43' }, 201)
      if (String(url).startsWith('/api/chat/channels?')) return json({ items: [{ ...channel, status }], total: 1 })
      return handler(url, init)
    })
    render(<SupportChat token="support-test" />)
    fireEvent.click(await screen.findByRole('button', { name: /software issue.*Muhammed Gani/ }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Chat actions' })).getByRole('button', { name: 'Approval' }))
    expect(within(screen.getByRole('group', { name: 'Chat actions' })).getByRole('button', { name: status === 'closed' ? 'Reopen' : 'Close' })).toBeVisible()
    const dialog = screen.getByRole('dialog', { name: 'Request manager approval' })
    fireEvent.change(within(dialog).getByLabelText('What needs approval?'), { target: { value: 'Install accounting software' } })
    fireEvent.change(within(dialog).getByLabelText('Reason and details'), { target: { value: 'Needed for monthly reporting.' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit approval request' }))
    expect(await screen.findByText(/Approval request IT-TKT-43 created as a ticket/)).toBeVisible()
    expect(fetchMock).toHaveBeenCalledWith('/api/me/requests', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        type: 'manager_approval',
        title: 'Manager approval: Install accounting software',
        description: 'Requested from support chat channel-1 (software issue).\n\nNeeded for monthly reporting.',
        priority: 'medium',
      }),
    }))
  })

  it('hides the default support title in conversations', async () => {
    const fetchMock = setup('it_team')
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).startsWith('/api/chat/channels?')) return json({ items: [{ ...channel, name: 'General support' }], total: 1 })
      return handler(url, init)
    })
    render(<SupportChat token="support-test" />)
    const conversation = await screen.findByRole('button', { name: /Test Employee.*Muhammed Gani/ })
    expect(screen.queryByText(/General support/i)).not.toBeInTheDocument()
    fireEvent.click(conversation)
    expect(await screen.findByText(message.body)).toBeVisible()
    expect(screen.queryByText(/General support/i)).not.toBeInTheDocument()
  })

  it('switches between the recent-chat tray and a conversation on narrow screens', async () => {
    const fetchMock = setup()
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => String(url).startsWith('/api/chat/channels?')
      ? json({ items: [channel], total: 1 })
      : handler(url, init))
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    render(<ChatAssistant context="Devices" token="support-test" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open ITMS assistant' }))
    fireEvent.click(await screen.findByRole('button', { name: /software issue.*Muhammed Gani/ }))

    expect(await screen.findByText(message.body)).toBeVisible()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Unsent draft' } })
    expect(screen.queryByRole('button', { name: 'Show recent chats' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to conversations' }))
    expect(screen.getByRole('button', { name: /software issue.*Muhammed Gani/ })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /software issue.*Muhammed Gani/ }))
    expect(screen.getByLabelText('Message')).toHaveValue('Unsent draft')
    fireEvent.click(screen.getByRole('button', { name: 'Back to conversations' }))
    expect(screen.getByRole('button', { name: /software issue.*Muhammed Gani/ })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /software issue.*Muhammed Gani/ }))
    expect(screen.getByLabelText('Message')).toHaveValue('Unsent draft')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
  })

  it('opens user search from the bottom plus and starts a chat after selecting a person', async () => {
    const fetchMock = setup('it_team')
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      const path = String(url)
      if (path === '/api/chat/participants?page=1') return json({ items: [{ id: 'one', fullName: 'First User', isMember: false }], hasMore: true })
      if (path === '/api/chat/participants?page=1&search=alex') return json({ items: [{ id: 'alex', fullName: 'Alex Example', isMember: false }], hasMore: false })
      return handler(url, init)
    })
    render(<SupportChat token="support-test" />)
    expect(await screen.findByText('No chats yet.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'New support chat' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
    const add = screen.getByRole('button', { name: 'Start new chat' })
    await waitFor(() => expect(add).toBeEnabled())
    fireEvent.click(add)
    const dialog = screen.getByRole('region', { name: 'Add person to chat' })
    expect(add).toHaveAttribute('aria-expanded', 'true')
    expect(add.parentElement?.parentElement).toContainElement(dialog)
    expect(dialog.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.keyDown(within(dialog).getByRole('searchbox', { name: 'Search users' }), { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'Add person to chat' })).not.toBeInTheDocument()
    expect(add).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(add)
    fireEvent.click(add)
    expect(screen.queryByRole('region', { name: 'Add person to chat' })).not.toBeInTheDocument()
    fireEvent.click(add)
    const reopened = screen.getByRole('region', { name: 'Add person to chat' })
    expect(await within(reopened).findByRole('button', { name: 'First User' })).toBeVisible()
    fireEvent.change(within(reopened).getByRole('searchbox', { name: 'Search users' }), { target: { value: 'alex' } })
    fireEvent.click(await within(reopened).findByRole('button', { name: 'Alex Example' }))
    expect(screen.queryByRole('region', { name: 'Add person to chat' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Alex Example' })).toBeVisible()
    expect(screen.getByText('New chat with Alex Example')).toBeVisible()
    expect(screen.getByText('Write and send your first message to create this chat.')).toBeVisible()
    expect(screen.getByLabelText('Message')).toHaveFocus()
    fireEvent.click(add)
    const pickerAgain = screen.getByRole('region', { name: 'Add person to chat' })
    fireEvent.change(within(pickerAgain).getByRole('searchbox', { name: 'Search users' }), { target: { value: 'alex' } })
    const selectedPerson = await within(pickerAgain).findByRole('button', { name: 'Alex Example · Selected' })
    expect(selectedPerson).toBeEnabled()
    fireEvent.click(selectedPerson)
    expect(screen.queryByRole('region', { name: 'Add person to chat' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Message')).toHaveFocus()
    expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/chat/channels' && init?.method === 'POST')).toBe(false)
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/channels', expect.objectContaining({ body: JSON.stringify({ name: 'General support', kind: 'support', initialMessage: 'Hello', supportParticipantIds: ['alex'] }) })))
    expect(await screen.findByText(message.body)).toBeVisible()
  })

  it('explains when starting a chat is unavailable', async () => {
    const fetchMock = setup()
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => String(url) === '/api/chat/support-options' ? json({ allowNewChats: false }) : handler(url, init))
    render(<SupportChat token="support-test" />)
    expect(await screen.findByText('New chats are currently unavailable.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Start new chat' })).toBeDisabled()
  })

  it('keeps new chat selections when switching conversations is cancelled', async () => {
    const fetchMock = setup()
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => {
      const path = String(url)
      if (path.startsWith('/api/chat/channels?') && path.includes('history=true')) return json({ items: [channel], total: 1 })
      if (path === '/api/chat/participants?page=1') return json({ items: [{ id: 'one', fullName: 'First User', isMember: false }], hasMore: false })
      return handler(url, init)
    })
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<SupportChat token="support-test" />)
    const add = await screen.findByRole('button', { name: 'Start new chat' })
    await waitFor(() => expect(add).toBeEnabled())
    fireEvent.click(add)
    const dialog = screen.getByRole('region', { name: 'Add person to chat' })
    fireEvent.click(await within(dialog).findByRole('button', { name: 'First User' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show chat history' }))
    fireEvent.click(await screen.findByRole('button', { name: /software issue.*Muhammed Gani/ }))
    expect(window.confirm).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Remove First User' })).toBeVisible()
  })

  it('sends on Enter but not Shift+Enter or while composing text', async () => {
    const fetchMock = setup()
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => String(url).startsWith('/api/chat/channels?')
      ? json({ items: [channel], total: 1 })
      : handler(url, init))
    render(<SupportChat token="support-test" />)
    await screen.findByRole('group', { name: 'Chat actions' })
    const composer = screen.getByRole('textbox', { name: 'Message' })
    expect(composer).toHaveAttribute('autocomplete', 'off')
    fireEvent.change(composer, { target: { value: 'Please help' } })
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(composer, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(composer, { key: 'Enter', keyCode: 229 })
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/messages') && init?.method === 'POST')).toBe(false)
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/channels/channel-1/messages', expect.objectContaining({ method: 'POST', body: JSON.stringify({ body: 'Please help' }) })))
    expect(await screen.findByText(message.body)).toBeVisible()
  })

  it.each(['employee', 'it_team', 'super_admin', 'admin'])('allows %s to send in an existing conversation and displays the assigned person and real replies', async role => {
    const fetchMock = setup(role)
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => String(url).startsWith('/api/chat/channels?')
      ? json({ items: [channel], total: 1 })
      : handler(url, init))
    render(<SupportChat token="support-test" />)
    expect(await screen.findByText('Hi! Your chat is assigned to Muhammed Gani from the IT team.')).toBeVisible()
    expect(await screen.findByText(message.body)).toBeVisible()
    expect(screen.getByText('Muhammed Gani - IT team')).toBeVisible()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Thank you' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/channels/channel-1/messages', expect.objectContaining({ body: JSON.stringify({ body: 'Thank you' }) })))
    expect(screen.getAllByText('Hi! Your chat is assigned to Muhammed Gani from the IT team.')).toHaveLength(1)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/chat/ai/'))).toBe(false)
  })

  it('does not claim a message was delivered when sending fails or retry automatically', async () => {
    const fetchMock = setup()
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => String(url).startsWith('/api/chat/channels?')
      ? json({ items: [channel], total: 1 })
      : init?.method === 'POST' ? json({}, 503) : handler(url, init))
    render(<SupportChat token="support-test" />)
    await screen.findByRole('group', { name: 'Chat actions' })
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Laptop issue' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    expect(await screen.findByText(/Delivery not confirmed/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    fetchMock.mockImplementation(async () => json({}, 503))
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading conversations' }))
    await screen.findByText('Support request unavailable.')
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  })

  it('records staff availability and withdraws it when disabled', async () => {
    const fetchMock = setup('it_team')
    render(<SupportChat token="support-test" />)
    expect(await screen.findByText('Muhammed Gani')).toBeVisible()
    expect(await screen.findByText('Online')).toBeVisible()
    expect(screen.getByText('Online').querySelector('.bg-emerald-500')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Available for chats'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/presence', expect.objectContaining({ body: JSON.stringify({ available: false }) })))
    expect(await screen.findByText('Offline')).toBeVisible()
    expect(screen.getByText('Offline').querySelector('.bg-red-500')).toBeInTheDocument()
  })

  it.each([json({}, 503), json({})])('shows unconfirmed availability when presence cannot be verified', async response => {
    const fetchMock = setup('it_team')
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => String(url) === '/api/chat/presence' ? response.clone() : handler(url, init))
    render(<SupportChat token="support-test" />)
    expect(await screen.findByText(/Availability not confirmed/)).toBeVisible()
    expect(screen.getByText('Unconfirmed').querySelector('.bg-orange-500')).toBeInTheDocument()
    expect(screen.queryByText('Online')).not.toBeInTheDocument()
    expect(screen.queryByText('Offline')).not.toBeInTheDocument()
  })

  it('shows unconfirmed while an availability change is awaiting a response', async () => {
    const fetchMock = setup('it_team')
    const handler = fetchMock.getMockImplementation()!
    let confirmOffline: ((response: Response) => void) | undefined
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url) === '/api/chat/presence' && init?.body === JSON.stringify({ available: false })) {
        return new Promise<Response>(resolve => { confirmOffline = resolve })
      }
      return handler(url, init)
    })
    render(<SupportChat token="support-test" />)
    await screen.findByText('Online')
    fireEvent.click(screen.getByLabelText('Available for chats'))
    expect(await screen.findByText('Unconfirmed')).toBeVisible()
    expect(screen.queryByText('Offline')).not.toBeInTheDocument()
    await act(async () => { confirmOffline?.(json({ available: false })) })
    expect(await screen.findByText('Offline')).toBeVisible()
  })

  it('sends a newer availability choice only after the previous update completes', async () => {
    const fetchMock = setup('it_team')
    const handler = fetchMock.getMockImplementation()!
    let confirmOnline: ((response: Response) => void) | undefined
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url) === '/api/chat/presence' && init?.body === JSON.stringify({ available: true })) {
        return new Promise<Response>(resolve => { confirmOnline = resolve })
      }
      return handler(url, init)
    })
    render(<SupportChat token="support-test" />)
    const toggle = await screen.findByRole('checkbox', { name: 'Available for chats' })
    await waitFor(() => expect(confirmOnline).toBeDefined())
    fireEvent.click(toggle)
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/chat/presence')).toHaveLength(1)
    expect(screen.getByText('Unconfirmed')).toBeVisible()
    await act(async () => { confirmOnline?.(json({ available: true })) })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/presence', expect.objectContaining({ body: JSON.stringify({ available: false }) })))
    expect(await screen.findByText('Offline')).toBeVisible()
  })

  it('retries an unconfirmed offline availability update', async () => {
    const fetchMock = setup('it_team')
    const handler = fetchMock.getMockImplementation()!
    let fail = true
    fetchMock.mockImplementation(async (url, init) => String(url) === '/api/chat/presence' && init?.body === JSON.stringify({ available: false }) && fail ? json({}, 503) : handler(url, init))
    render(<SupportChat token="support-test" />)
    await screen.findByText('Online')
    fireEvent.click(screen.getByLabelText('Available for chats'))
    await screen.findByRole('alert')
    expect(screen.getByText('Unconfirmed')).toBeVisible()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry availability' }))
    expect(await screen.findByText('Offline')).toBeVisible()
  })

  it('does not start a second presence session while inbox identity is loading', async () => {
    const fetchMock = setup('it_team')
    const handler = fetchMock.getMockImplementation()!
    let firstIdentity: ((response: Response) => void) | undefined
    let first = true
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url) === '/api/auth/me' && first) {
        first = false
        return new Promise<Response>(resolve => { firstIdentity = resolve })
      }
      return handler(url, init)
    })
    render(<ChatAssistant context="Devices" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open ITMS assistant' }))
    expect(await screen.findByText('Availability unconfirmed')).toBeVisible()
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/chat/presence')).toHaveLength(0)
    await act(async () => { firstIdentity?.(json({ id: 'gani', full_name: 'Muhammed Gani', role: 'it_team' })) })
    expect(await screen.findByText('Online')).toBeVisible()
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/chat/presence')).toHaveLength(1)
  })

  it('can retry inbox identity verification when the chat session is already connected', async () => {
    const fetchMock = setup('it_team')
    const handler = fetchMock.getMockImplementation()!
    let first = true
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url) === '/api/auth/me' && first) { first = false; return json({}, 503) }
      return handler(url, init)
    })
    render(<ChatAssistant context="Devices" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open ITMS assistant' }))
    expect(await screen.findByText('Availability unconfirmed')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Retry availability' }))
    expect(await screen.findByText('Online')).toBeVisible()
    expect(screen.getByText('Muhammed Gani')).toBeVisible()
  })

  it('shows the signed-in employee name without inventing a presence status', async () => {
    setup()
    render(<SupportChat token="support-test" />)
    expect(await screen.findByText('Test Employee')).toBeVisible()
    expect(screen.getByText('Availability unconfirmed').querySelector('.bg-orange-500')).toBeInTheDocument()
  })

  it.each(['it_team', 'super_admin', 'admin'])('keeps %s available with the popup closed and preserves an explicit offline choice', async role => {
    vi.useFakeTimers()
    const fetchMock = setup(role)
    render(<ChatAssistant context="Devices" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.queryByRole('region', { name: 'ITMS assistant' })).not.toBeInTheDocument()
    const presenceCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) === '/api/chat/presence')
    expect(presenceCalls()).toHaveLength(1)
    expect(presenceCalls()[0][1]?.body).toBe(JSON.stringify({ available: true }))
    fireEvent(document, new Event('visibilitychange'))
    fireEvent(document, new Event('visibilitychange'))
    expect(presenceCalls()).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(presenceCalls()).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Open ITMS assistant' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(presenceCalls()).toHaveLength(2)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Available for chats' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(presenceCalls().at(-1)?.[1]?.body).toBe(JSON.stringify({ available: false }))
    const offlineCalls = presenceCalls().length
    fireEvent.click(screen.getByRole('button', { name: 'Close assistant' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(presenceCalls()).toHaveLength(offlineCalls)
    fireEvent.click(screen.getByRole('button', { name: 'Open ITMS assistant' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByRole('checkbox', { name: 'Available for chats' })).not.toBeChecked()
    expect(presenceCalls()).toHaveLength(offlineCalls)
  })

  it('shows a waiting state without inventing an assignee', async () => {
    const fetchMock = setup()
    const handler = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) => String(url).startsWith('/api/chat/channels?') ? json({ items: [{ ...channel, primaryOwner: undefined }], total: 1 }) : handler(url, init))
    render(<SupportChat token="support-test" />)
    fireEvent.click(await screen.findByRole('button', { name: /software issue.*Waiting for IT team/ }))
    expect(await screen.findByText('Your chat is waiting for an IT-team assignee.')).toBeVisible()
    expect(screen.queryByText(/Your chat is assigned to/)).not.toBeInTheDocument()
  })

  it('pops up IT support for a new incoming conversation without reopening unchanged activity', async () => {
    vi.useFakeTimers()
    const fetchMock = setup('it_team')
    const handler = fetchMock.getMockImplementation()!
    let incoming = false
    fetchMock.mockImplementation(async (url, init) => String(url).startsWith('/api/chat/channels?')
      ? json({ items: incoming ? [{ ...channel, messageCount: 1 }] : [], total: incoming ? 1 : 0 }) : handler(url, init))
    render(<ChatAssistant context="Devices" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.queryByRole('region', { name: 'ITMS assistant' })).not.toBeInTheDocument()
    incoming = true
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(screen.getByRole('region', { name: 'ITMS assistant' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Chat' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Close assistant' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(screen.queryByRole('region', { name: 'ITMS assistant' })).not.toBeInTheDocument()
  })

  it.each(['employee', 'it_team', 'super_admin', 'admin'])('detects a fast first reply for %s without popping up its own messages', async role => {
    vi.useFakeTimers()
    const fetchMock = setup(role)
    const handler = fetchMock.getMockImplementation()!
    const ownId = role === 'employee' ? 'employee' : 'gani'
    let created = false
    let ownMessage = false
    let count = 2
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).startsWith('/api/chat/channels?')) return json({ items: created ? [{ ...channel, createdBy: { id: ownId }, messageCount: count }] : [], total: created ? 1 : 0 })
      if (String(url).includes('/messages?') && ownMessage) return json({ items: [{ ...message, author: { id: ownId, fullName: 'Me' } }], total: 1 })
      return handler(url, init)
    })
    render(<ChatAssistant context="Devices" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    created = true
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(screen.getByRole('region', { name: 'ITMS assistant' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Close assistant' }))
    ownMessage = true
    count = 3
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(screen.queryByRole('region', { name: 'ITMS assistant' })).not.toBeInTheDocument()
  })

  it('clears support conversations on logout', async () => {
    setup()
    render(<ChatAssistant context="Devices" />)
    fireEvent.click(screen.getByRole('button', { name: 'Open ITMS assistant' }))
    await screen.findByText('No chats yet.')
    act(() => { localStorage.removeItem('itms_token'); window.dispatchEvent(new Event('itms-auth-changed')) })
    expect(await screen.findByText('Sign in to view and send messages.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'New support chat' })).not.toBeInTheDocument()
  })

  it.each(['employee', 'it_team', 'super_admin', 'admin'])('opens a reply popup for %s and stops polling after logout', async role => {
    vi.useFakeTimers()
    const fetchMock = setup(role)
    const handler = fetchMock.getMockImplementation()!
    let count = 1
    fetchMock.mockImplementation(async (url, init) => String(url).startsWith('/api/chat/channels?')
      ? json({ items: [{ ...channel, messageCount: count }], total: 1 }) : handler(url, init))
    render(<ChatAssistant context="Devices" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    count = 2
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const previousCalls = fetchMock.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(fetchMock.mock.calls).toHaveLength(previousCalls)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByRole('region', { name: 'ITMS assistant' })).toBeVisible()
    act(() => { localStorage.removeItem('itms_token'); window.dispatchEvent(new Event('itms-auth-changed')) })
    const signedOutCalls = fetchMock.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(fetchMock.mock.calls).toHaveLength(signedOutCalls)
    expect(screen.getByText('Sign in to view and send messages.')).toBeVisible()
  })

})