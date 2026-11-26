import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardView } from './DashboardView'

vi.mock('react-chartjs-2', () => ({ Chart: () => <div>Security chart</div>, Doughnut: () => <div>Device chart</div> }))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const data: Record<string, unknown> = {
  '/api/devices/directory': { summary: { all: 4, flagged: 1 }, users: [{ status: 'online' }] },
  '/api/patch/dashboard': { total: 4, upToDate: 3, pending: 1, failed: 0 },
  '/api/alerts/dashboard': { systems: [], trend: { dailyBuckets: [] } },
  '/api/gatepass': [{ status: 'pending' }],
  '/api/audit': [],
  '/api/me/profile': { full_name: 'Test User' },
}

beforeEach(() => {
  localStorage.setItem('itms_token', 'dashboard-test')
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('DashboardView', () => {
  it('shows available sections when one service fails and retries the failed section', async () => {
    let failed = true
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      return path === '/api/patch/dashboard' && failed ? json({ error: 'unavailable' }, 503) : json(data[path])
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<DashboardView />)
    expect(await screen.findByText('4 Endpoints')).toBeVisible()
    expect(screen.getByText('1 Requests')).toBeVisible()
    expect(screen.getByText('Security chart')).toBeVisible()
    expect(screen.getByText('Device status unavailable.')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('patches')
    expect(screen.queryByText('Live API')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /refresh dashboard/i })).not.toBeInTheDocument()
    failed = false
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Device chart')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('refreshes every 60 seconds and clears previous account data immediately', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => json(data[String(input)]))
    vi.stubGlobal('fetch', fetchMock)
    render(<DashboardView />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText('4 Endpoints')).toBeVisible()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fetchMock).toHaveBeenCalledTimes(12)
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    act(() => { localStorage.setItem('itms_token', 'new-account'); window.dispatchEvent(new Event('itms-auth-changed')) })
    expect(screen.queryByText('4 Endpoints')).not.toBeInTheDocument()
  })

  it('keeps successful sections when another request times out', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== '/api/patch/dashboard') return Promise.resolve(json(data[String(input)]))
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }))
    render(<DashboardView />)
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(screen.getByText('4 Endpoints')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('patches')
    expect(screen.getByRole('alert')).toHaveTextContent('timed out')
    expect(screen.getByText('Device status unavailable.')).toBeVisible()
  })

  it('ignores a previous account response that completes after switching accounts', async () => {
    const pending: Array<(response: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => pending.push(resolve))))
    render(<DashboardView />)
    expect(pending).toHaveLength(6)
    act(() => { localStorage.setItem('itms_token', 'new-account'); window.dispatchEvent(new Event('itms-auth-changed')) })
    expect(pending).toHaveLength(12)
    await act(async () => {
      Object.values(data).forEach((value, index) => pending[index](json(value)))
    })
    expect(screen.queryByText('4 Endpoints')).not.toBeInTheDocument()
    await act(async () => {
      Object.values(data).forEach((value, index) => pending[index + 6](json(value)))
    })
    expect(screen.getByText('4 Endpoints')).toBeVisible()
  })
})
