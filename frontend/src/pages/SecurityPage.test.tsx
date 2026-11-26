import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SecurityPage } from './SecurityPage'
import { PortalReadOnlyContext } from '../lib/portalAccess'

vi.mock('react-chartjs-2', () => ({
  Line: ({ data }: { data: unknown }) => <pre data-testid="threat-chart">{JSON.stringify(data)}</pre>,
  Doughnut: ({ data }: { data: unknown }) => <pre data-testid="severity-chart">{JSON.stringify(data)}</pre>,
}))
vi.mock('../lib/exports', () => ({ exportCsv: vi.fn(), exportElementPdf: vi.fn() }))

const system = { key: 'recorded-event', hostname: 'recorded-device', moduleLabel: 'Wazuh', severity: 'high', latestTitle: 'Recorded finding', latestDetail: 'Recorded detail', createdAt: '2026-10-05T01:00:00Z', status: 'error', errorCount: 1 }
const dashboard = { source: 'wazuh', sourceLabel: 'Wazuh', systems: [system], trend: { dailyBuckets: [{ date: '2026-10-05', count: 3 }], last7DaysTotal: 3 }, moduleCards: [] }
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })

describe('Security production data', () => {
  beforeEach(() => { localStorage.clear(); localStorage.setItem('itms_token', 'fixture-token') })
  afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('loads employee findings without requesting staff-only automations', async () => {
    const fetchMock = vi.fn(async () => json([{ id: 'employee-alert', hostname: system.hostname, title: system.latestTitle, detail: system.latestDetail, severity: 'high', resolved: false }]))
    vi.stubGlobal('fetch', fetchMock)
    render(<SecurityPage role="employee" />)
    await screen.findByText('Recorded finding')
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/me/alerts', expect.anything())
    expect(screen.queryByRole('button', { name: 'Automations' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.queryByTestId('threat-chart')).not.toBeInTheDocument()
  })

  it('lets auditors inspect findings but disables automation writes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => json(String(input).includes('/dashboard?') ? dashboard : { items: [] }))
    vi.stubGlobal('fetch', fetchMock)
    render(<PortalReadOnlyContext.Provider value={true}><SecurityPage /></PortalReadOnlyContext.Provider>)
    await screen.findByText('Recorded finding')
    fireEvent.click(screen.getByRole('button', { name: 'Review fix' }))
    expect(screen.getByRole('button', { name: 'Save as automation' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }))
    expect(screen.getByRole('button', { name: 'New automation' })).toBeDisabled()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('sends the displayed employee alert details to IT as a tracked request', async () => {
    const alert = { id: 'alert-id', hostname: 'My laptop', sourceLabel: 'Wazuh', title: 'Suspicious login', detail: 'Repeated failed sign-ins detected', severity: 'high', resolved: false, createdAt: '2026-10-08T10:00:00Z' }
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? json({ id: 'request-id', ticketNumber: 'IT-TKT-1' }, 201) : json([alert]))
    vi.stubGlobal('fetch', fetchMock)
    render(<SecurityPage role="employee" />)
    await screen.findByText(alert.detail)
    expect(screen.getByText(/My laptop.*Wazuh/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Send to IT: Suspicious login' }))
    await screen.findByText('Sent to IT: IT-TKT-1')
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(call[0]).toBe('/api/me/requests')
    const payload = JSON.parse(String(call[1]?.body))
    expect(payload).toMatchObject({ type: 'security_alert', priority: 'high', title: 'Security alert: Suspicious login' })
    expect(payload.description).toContain('Alert ID: alert-id')
    expect(payload.description).toContain(alert.detail)
    expect(screen.queryByRole('button', { name: 'Send to IT: Suspicious login' })).not.toBeInTheDocument()
  })

  it('prevents duplicate or automatic retry of an uncertain alert submission', async () => {
    let rejectSend!: (error: Error) => void
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? new Promise<Response>((_resolve, reject) => { rejectSend = reject }) : Promise.resolve(json([{ id: 'alert', title: 'Finding', detail: 'Details', severity: 'medium', resolved: false }])))
    vi.stubGlobal('fetch', fetchMock)
    render(<SecurityPage role="employee" />)
    const send = await screen.findByRole('button', { name: 'Send to IT: Finding' })
    fireEvent.click(send); fireEvent.click(send)
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    await act(async () => rejectSend(new Error('Network failure')))
    await screen.findByText('Submission not confirmed. Check request history before sending again.')
    expect(screen.queryByRole('button', { name: 'Send to IT: Finding' })).not.toBeInTheDocument()
  })

  it('aborts forwarding and discards the result after an account change', async () => {
    let resolveSend!: (response: Response) => void
    let signal: AbortSignal | null | undefined
    vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        signal = init.signal
        return new Promise<Response>(resolve => { resolveSend = resolve })
      }
      return Promise.resolve(json([{ id: 'alert', title: 'Private finding', detail: 'Details', severity: 'high', resolved: false }]))
    }))
    render(<SecurityPage role="employee" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Send to IT: Private finding' }))
    act(() => { localStorage.removeItem('itms_token'); window.dispatchEvent(new StorageEvent('storage', { key: 'itms_token' })) })
    expect(signal?.aborted).toBe(true)
    await act(async () => resolveSend(json({ id: 'private-ticket', ticketNumber: 'PRIVATE-1' })))
    expect(screen.queryByText(/Sent to IT/)).not.toBeInTheDocument()
    expect(screen.queryByText('Private finding')).not.toBeInTheDocument()
  })

  it('does not show invented findings or configured integrations while loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    render(<SecurityPage />)
    expect(screen.queryByText('Demo data')).not.toBeInTheDocument()
    expect(screen.queryByText('SYS-0184')).not.toBeInTheDocument()
    expect(screen.queryByText('Available')).not.toBeInTheDocument()
    expect(screen.getByTestId('threat-chart')).not.toHaveTextContent('[4,7,5,14,9,18,13]')
  })

  it('reports unavailable data after failed reads without inventing findings or enabling writes and exports', async () => {
    const fetchMock = vi.fn(async () => json({ error: 'Security unavailable' }, 503))
    vi.stubGlobal('fetch', fetchMock)
    render(<SecurityPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Security unavailable')
    expect(screen.queryByRole('button', { name: 'Review fix' })).not.toBeInTheDocument()
    expect(screen.queryByText('Demo data')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Automations' }))
    expect(screen.getByRole('button', { name: 'New automation' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reports' }))
    expect(screen.getByRole('button', { name: 'CSV' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'PDF' })).toBeDisabled()
    expect(fetchMock.mock.calls).toHaveLength(4)
  })

  it('shows recorded findings and clears them if a refresh fails', async () => {
    let failed = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => failed ? json({ error: 'Refresh unavailable' }, 503) : json(String(input).includes('/dashboard?') ? dashboard : { items: [] })))
    render(<SecurityPage />)
    expect(await screen.findByText('Recorded finding')).toBeVisible()
    expect(screen.getByTestId('threat-chart')).toHaveTextContent('"data":[3]')
    failed = true
    act(() => window.dispatchEvent(new Event('itms-auth-changed')))
    await screen.findByRole('alert')
    await waitFor(() => expect(screen.queryByText('Recorded finding')).not.toBeInTheDocument())
    expect(screen.getByTestId('threat-chart')).not.toHaveTextContent('"data":[3]')
    expect(screen.queryByText('SYS-0184')).not.toBeInTheDocument()
  })

  it('ignores a late response from the previous detector', async () => {
    let resolvePrevious!: (response: Response) => void
    let previousSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path.includes('/dashboard?source=wazuh')) {
        previousSignal = init?.signal ?? undefined
        return new Promise<Response>(resolve => { resolvePrevious = resolve })
      }
      if (path.includes('/dashboard?')) return json({ ...dashboard, source: 'clamav', systems: [{ ...system, latestTitle: 'ClamAV recorded finding' }] })
      if (path.endsWith('/integrations')) return json({ items: [{ source: 'clamav', label: 'ClamAV', configured: true, eventCount: 2 }] })
      return json({ items: [] })
    }))
    render(<SecurityPage />)
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /ClamAV/ }))
    expect(await screen.findByText('ClamAV recorded finding')).toBeVisible()
    expect(previousSignal?.aborted).toBe(true)
    await act(async () => { resolvePrevious(json(dashboard)) })
    expect(screen.queryByText('Recorded finding')).not.toBeInTheDocument()
    expect(screen.getByText('ClamAV recorded finding')).toBeVisible()
  })

  it('switches integration cards immediately and reloads only the selected dashboard', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path.includes('/dashboard?source=openscap')) return json({ ...dashboard, source: 'openscap', systems: [{ ...system, latestTitle: 'OpenSCAP recorded finding' }] })
      if (path.includes('/dashboard?')) return json(dashboard)
      if (path.endsWith('/integrations')) return json({ items: [
        { source: 'wazuh', label: 'Wazuh', configured: false, eventCount: 429 },
        { source: 'openscap', label: 'Hardening / OpenSCAP', configured: true, eventCount: 115 },
      ] })
      return json({ items: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<SecurityPage />)
    await screen.findByText('Recorded finding')
    expect(screen.getByRole('button', { name: /Wazuh/ })).toHaveTextContent('Not configured')
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.queryByText('Live API')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Refresh data' })).not.toBeInTheDocument()
    fetchMock.mockClear()

    fireEvent.click(screen.getByRole('button', { name: /Hardening \/ OpenSCAP/ }))
    expect(screen.getByRole('button', { name: /Hardening \/ OpenSCAP/ })).toHaveClass('ring-2')
    expect(await screen.findByText('OpenSCAP recorded finding')).toBeVisible()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/security/dashboard?source=openscap')
  })

  it('does not request security data without a session', () => {
    localStorage.clear()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<SecurityPage />)
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in to load security data.')
    expect(screen.queryByText('SYS-0184')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})