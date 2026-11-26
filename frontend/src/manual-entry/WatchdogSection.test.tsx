import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ManualEntryPage } from './ManualEntryPage'
import { PageErrorBoundary } from '../components/PageErrorBoundary'
import { browserFailures } from '../lib/browserFailures'
import { deferred, json } from './fixtures.test-support'

const report = () => ({ checkedAt: new Date().toISOString(), status: 'warning', checks: [
  { id: 'database', name: 'Database', status: 'ok', detail: 'Database connection responded.', action: '', href: '/settings' },
  { id: 'ssh', name: 'SSH', status: 'warning', detail: 'SPARE: 2 unresolved alerts.', action: 'Check the address, port and VPN route.', href: '/devices/30000000-0000-0000-0000-000000000003/alerts' },
] })
const props = () => ({ token: 'account-one', verifiedAdministrator: true, onDenied: vi.fn(), navigate: vi.fn(), watchdogRoute: true })

describe('Settings watchdog', () => {
  beforeEach(() => { localStorage.clear(); browserFailures(''); localStorage.setItem('itms_token', 'account-one'); vi.stubGlobal('fetch', vi.fn(async () => json(report()))) })
  afterEach(() => { vi.useRealTimers(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('shows errors, filters checks, links devices and refreshes only on request', async () => {
    const page = props()
    render(<ManualEntryPage {...page} />)
    await screen.findByText('SPARE: 2 unresolved alerts.')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('/api/admin/watchdog', expect.objectContaining({ method: 'GET', cache: 'no-store', headers: { Authorization: 'Bearer account-one' } }))
    expect(screen.getByText('Deployment readiness: not certified')).toBeVisible()
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'warning' } })
    expect(screen.queryByText('Database connection responded.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Open SSH' }))
    expect(page.navigate).toHaveBeenCalledWith(report().checks[1].href)
    fireEvent.change(screen.getByLabelText('Search checks'), { target: { value: 'not-present' } })
    expect(screen.getByText('No matching checks.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh report' }))
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  })

  it.each([401, 403])('clears report on HTTP %s without exposing errors', async status => {
    vi.mocked(fetch).mockResolvedValue(json({ error: 'private error' }, status))
    const page = props()
    render(<ManualEntryPage {...page} />)
    await screen.findByText('Access denied. Settings data has been cleared.')
    expect(page.onDenied).toHaveBeenCalled()
    expect(screen.queryByText('private error')).not.toBeInTheDocument()
  })

  it('bounds a stalled request and ignores its late response', async () => {
    vi.useFakeTimers()
    const pending = deferred<Response>()
    vi.mocked(fetch).mockReturnValue(pending.promise)
    render(<ManualEntryPage {...props()} />)
    await act(async () => { vi.advanceTimersByTime(8_000) })
    expect(screen.getByRole('alert')).toHaveTextContent('timed out')
    await act(async () => { pending.resolve(json(report())) })
    expect(screen.queryByText('SPARE: 2 unresolved alerts.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Refresh report' })).toBeEnabled()
  })

  it('marks stale reports and rejects malformed or unsafe links', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ ...report(), checkedAt: new Date(Date.now() - 180_000).toISOString() }))
    render(<ManualEntryPage {...props()} />)
    await screen.findByText('Report stale')
    vi.mocked(fetch).mockResolvedValueOnce(json({ ...report(), checks: [{ ...report().checks[0], href: 'https://external.invalid' }] }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh report' }))
    await screen.findByText(/Watchdog unavailable/)
    expect(screen.queryByRole('link', { name: 'Open Database' })).not.toBeInTheDocument()
  })

  it('does not request reports for an unverified account', () => {
    render(<ManualEntryPage {...props()} verifiedAdministrator={false} />)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('contains page failures and shows safe summaries in Settings only for the same account', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    function BrokenPage(): never { throw new Error('private exception payload') }
    const page = props()
    const boundary = render(<PageErrorBoundary token={page.token} page="Devices" canOpenSettings navigate={page.navigate}><BrokenPage /></PageErrorBoundary>)
    expect(screen.getByRole('heading', { name: 'Page failed to load' })).toBeVisible()
    expect(screen.queryByText('private exception payload')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Open watchdog' }))
    expect(page.navigate).toHaveBeenCalledWith('/settings/watchdog')
    boundary.unmount()
    render(<ManualEntryPage {...page} />)
    await screen.findByRole('region', { name: 'Browser page errors' })
    expect(browserFailures(page.token)).toHaveLength(1)
    localStorage.setItem('itms_token', 'other-account')
    expect(browserFailures('other-account')).toEqual([])
  })
})