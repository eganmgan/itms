import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PatchPage } from './PatchPage'

vi.mock('../components/SSHTerminal', () => ({ SSHTerminal: ({ assetId, systemId }: { assetId: string; systemId: string }) => <div data-testid="ssh-terminal" data-asset-id={assetId} data-system-id={systemId} /> }))

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('PatchPage', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/patch')
    localStorage.setItem('itms_token', 'test-token')
  })
  afterEach(() => vi.unstubAllGlobals())

  it('loads the workspace and all read-only panels', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/patch/dashboard') return Promise.resolve(jsonResponse({ total: 2, upToDate: 1, pending: 1, failed: 0, rebootPending: 0 }))
      if (path === '/api/patch/devices') return Promise.resolve(jsonResponse([]))
      if (path === '/api/patch/logs') return Promise.resolve(jsonResponse({ items: [
        { id: 'log-1', assetId: 'asset-1', assetTag: 'ZR-1001', hostname: 'host-1', department: 'Engineering', status: 'success', createdAt: '2026-09-16T05:00:00Z' },
        { id: 'log-2', assetId: 'asset-2', assetTag: 'ZBL-2001', hostname: 'host-2', department: 'Finance', status: 'failed', createdAt: '2026-09-16T06:00:00Z' },
      ] }))
      if (path === '/api/patch/audit') return Promise.resolve(jsonResponse({ items: [] }))
      if (path === '/api/patch/alerts') return Promise.resolve(jsonResponse({ items: [
        { id: 'alert-1', assetTag: 'ZR-1001', hostname: 'host-1', department: 'Engineering', title: 'Kernel security update', detail: 'linux-image update pending', severity: 'critical', resolved: false, createdAt: '2026-09-16T05:00:00Z' },
        { id: 'alert-2', hostname: 'host-2', department: 'Finance', title: 'Reboot complete', severity: 'low', resolved: true, createdAt: '2026-09-15T05:00:00Z' },
      ] }))
      if (path === '/api/patch/policies') return Promise.resolve(jsonResponse({ windowEnabled: true, windowStart: '22:00', windowEnd: '06:00', allowedRings: ['pilot'], departmentRings: [] }))
      if (path === '/api/patch/automations') return Promise.resolve(jsonResponse({ items: [] }))
      if (path === '/api/patch/reports') return Promise.resolve(jsonResponse([{ id: 'report-1', scopeLabel: 'Engineering', successCount: 8, failedCount: 2, rowCount: 10 }]))
      return Promise.resolve(jsonResponse({ error: 'not found' }, 404))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<PatchPage />)
    expect(await screen.findByText('Live API')).toBeVisible()

    fireEvent.click(screen.getByRole('tab', { name: 'Logs' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/patch/logs', expect.anything()))
    expect(await screen.findByText('ZR-1001')).toBeVisible()
    expect(screen.getAllByText('50%')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'CSV' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'JSON' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'PDF' })).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: 'Audit' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/patch/audit', expect.anything()))

    fireEvent.click(screen.getByRole('tab', { name: 'Salt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Alerts' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/patch/alerts', expect.anything()))
    expect(await screen.findByText('Kernel security update')).toBeVisible()
    expect(screen.getByText('Critical update')).toBeVisible()
    expect(screen.getByText('ZR-1001')).toBeVisible()
    expect(screen.queryByText('Reboot complete')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Resolved' }))
    expect(screen.getByText('Reboot complete')).toBeVisible()
    fireEvent.change(screen.getByLabelText('Search patch alerts'), { target: { value: 'Finance' } })
    expect(screen.getByText('Reboot complete')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Policies' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/patch/policies', expect.anything()))

    fireEvent.click(screen.getByRole('tab', { name: 'Automation' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/patch/automations', expect.anything()))
    fireEvent.click(screen.getByRole('tab', { name: 'Report' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/patch/reports', expect.anything()))
    expect(await screen.findByText('Zerodha ITMS Reporting System')).toBeVisible()
    expect(screen.getAllByText('80%')).toHaveLength(2)

    vi.unstubAllGlobals()
  })

  it('runs patch, SSH, policy, and automation actions', async () => {
    const device = { id: 'asset-1', assetTag: 'ZBL-1001', hostname: 'host-1', osName: 'Ubuntu', patchStatus: 'pending', department: { name: 'Engineering' } }
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/patch/dashboard') return Promise.resolve(jsonResponse({ total: 1, upToDate: 0, pending: 1, failed: 0, rebootPending: 0 }))
      if (path === '/api/patch/devices') return Promise.resolve(jsonResponse([device]))
      if (path === '/api/patch/reports' && init?.method === 'POST') return Promise.resolve(jsonResponse({ id: 'saved-report' }, 201))
      if (path === '/api/patch/batch') {
        const request = JSON.parse(String(init?.body)) as { action: string }
        if (request.action === 'custom-command') return Promise.resolve(jsonResponse({ targetCount: 1, results: [{ assetId: 'asset-1', status: 'completed', result: { target: 'host-1', status: 'completed', result: { stdout: 'host-1\nLinux 6.8.0', stderr: '', retcode: 0, pid: 4127 } } }] }))
        return Promise.resolve(jsonResponse({ targetCount: 1, results: [{ assetId: 'asset-1', status: 'completed' }] }))
      }
      if (path === '/api/ssh/session') return Promise.resolve(jsonResponse({ ok: true }))
      if (path === '/api/patch/policies' && init?.method === 'PUT') return Promise.resolve(jsonResponse(JSON.parse(String(init.body))))
      if (path === '/api/patch/policies') return Promise.resolve(jsonResponse({ windowEnabled: true, windowStart: '22:00', windowEnd: '06:00', allowedRings: ['pilot'], departmentRings: [] }))
      if (path === '/api/patch/automations' && init?.method === 'POST') return Promise.resolve(jsonResponse({ id: 'automation-1', name: 'patch.custom', kind: 'sls', content: 'pkg.uptodate: []', description: '' }, 201))
      if (path === '/api/patch/automations') return Promise.resolve(jsonResponse({ items: [] }))
      return Promise.resolve(jsonResponse({ error: 'not found' }, 404))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<PatchPage />)
    expect(await screen.findByText('Live API')).toBeVisible()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Review state.apply' }))
    fireEvent.click(screen.getByRole('button', { name: /confirm & run/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/patch/batch', expect.objectContaining({ method: 'POST' })))
    expect(await screen.findByText(/asset-1: COMPLETED/i)).toBeVisible()
    const stateCall = fetchMock.mock.calls.find(([path, init]) => path === '/api/patch/batch' && JSON.parse(String(init?.body)).action === 'custom-state')
    expect(JSON.parse(String(stateCall?.[1]?.body))).toMatchObject({ action: 'custom-state', state: 'patch.baseline', command: '' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: /cmd\.run.*diagnostic command/i }))
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'uptime' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review cmd.run' }))
    fireEvent.click(screen.getByRole('button', { name: /confirm & run/i }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => path === '/api/patch/batch')).toHaveLength(2))
    const commandCall = fetchMock.mock.calls.find(([path, init]) => path === '/api/patch/batch' && JSON.parse(String(init?.body)).action === 'custom-command')
    expect(JSON.parse(String(commandCall?.[1]?.body))).toMatchObject({ action: 'custom-command', command: 'uptime', state: '' })
    expect(await screen.findByText('host-1: COMPLETED')).toBeVisible()
    expect(screen.getByText(/Linux 6\.8\.0/)).toBeVisible()
    expect(screen.getByText(/Exit code: 0.*PID: 4127/)).toBeVisible()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Review cmd.run' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /test\.ping.*salt connectivity/i }))
    expect(screen.queryByLabelText('Command')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review test.ping' }))
    fireEvent.click(screen.getByRole('button', { name: /confirm & run/i }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([path]) => path === '/api/patch/batch')).toHaveLength(3))
    const pingCall = fetchMock.mock.calls.find(([path, init]) => path === '/api/patch/batch' && JSON.parse(String(init?.body)).action === 'test.ping')
    expect(JSON.parse(String(pingCall?.[1]?.body))).toMatchObject({ action: 'test.ping', state: '', command: '' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review test.ping' })).toBeEnabled())

    fireEvent.click(screen.getByRole('tab', { name: 'SSH' }))
    expect(screen.getByText('ZBL-1001')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'SSH Terminal' }))
    expect(await screen.findByRole('dialog', { name: /SSH.*ZBL-1001/i })).toBeVisible()
    expect(screen.getByTestId('ssh-terminal')).toHaveAttribute('data-asset-id', 'asset-1')
    expect(screen.getByTestId('ssh-terminal')).toHaveAttribute('data-system-id', 'ZBL-1001')
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/ssh/session')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /close dialog/i }))

    fireEvent.click(screen.getByRole('tab', { name: 'Salt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Policies' }))
    await waitFor(() => expect(screen.getByLabelText('Window starts')).toHaveValue('22:00'))
    expect(screen.getByLabelText('Window ends')).toHaveValue('06:00')
    fireEvent.change(screen.getByLabelText('Window starts'), { target: { value: '21:30' } })
    fireEvent.click(screen.getByLabelText('Broad'))
    fireEvent.click(screen.getByRole('button', { name: 'Save Policy' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/patch/policies', expect.objectContaining({ method: 'PUT' })))
    const policyCall = fetchMock.mock.calls.find(([path, init]) => path === '/api/patch/policies' && init?.method === 'PUT')
    expect(JSON.parse(String(policyCall?.[1]?.body))).toMatchObject({ windowEnabled: true, windowStart: '21:30', windowEnd: '06:00', allowedRings: ['pilot', 'broad'] })

    fireEvent.click(screen.getByRole('tab', { name: 'Automation' }))
    fireEvent.click(screen.getByRole('button', { name: 'New .sls State' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save Automation' }))
    expect(await screen.findByText('patch.custom')).toBeVisible()

    vi.unstubAllGlobals()
  })

  it('persists the completed batch snapshot with captured scope, times, device IDs and package evidence', async () => {
    const device = { id: 'asset-1', assetTag: 'TAG-1', hostname: 'host-1', patchStatus: 'pending', department: { name: 'Engineering' } }
    const saltResult = { return: [{ minion: { 'pkg_|-updates': { result: true, changes: { openssl: { old: '1', new: '2' } } } } }] }
    const item = { assetId: 'asset-1', assetTag: 'TAG-1', status: 'completed', result: { target: 'minion', state: 'patch.baseline', action: 'custom-state', result: saltResult, historyRecorded: true } }
    let finishBatch!: (response: Response) => void
    let requestStarted = 0
    let requestFinished = 0
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/patch/dashboard') return Promise.resolve(jsonResponse({ total: 1, upToDate: 0, pending: 1, failed: 0, rebootPending: 0 }))
      if (path === '/api/patch/devices') return Promise.resolve(jsonResponse([device]))
      if (path === '/api/patch/batch') {
        requestStarted = Date.now()
        return new Promise<Response>(resolve => { finishBatch = resolve })
      }
      if (path === '/api/patch/reports' && init?.method === 'POST') return Promise.resolve(jsonResponse({ id: 'report-1' }, 201))
      return Promise.resolve(jsonResponse([]))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<PatchPage />)
    expect(await screen.findByText('Live API')).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeEnabled())
    const beforeRun = Date.now()
    fireEvent.click(screen.getByRole('button', { name: 'Review state.apply' }))
    fireEvent.click(screen.getByRole('button', { name: /confirm & run/i }))
    await waitFor(() => expect(finishBatch).toBeTypeOf('function'))
    // Edits while the remote request is pending must not change its report.
    fireEvent.click(screen.getByRole('button', { name: 'Single System ID Execution' }))
    fireEvent.change(screen.getByLabelText('System ID'), { target: { value: 'different-system' } })
    requestFinished = Date.now()
    finishBatch(jsonResponse({ targetCount: 1, results: [item] }))
    expect(await screen.findByText('Execution report saved.')).toBeVisible()
    const reportCalls = fetchMock.mock.calls.filter(([path, init]) => path === '/api/patch/reports' && init?.method === 'POST')
    expect(reportCalls).toHaveLength(1)
    expect(reportCalls[0][1]?.headers).toEqual({ Authorization: 'Bearer test-token', 'Content-Type': 'application/json' })
    const snapshot = JSON.parse(String(reportCalls[0][1]?.body))
    expect(snapshot.scopeLabel).toBe('Departments: Engineering')
    expect(Date.parse(snapshot.requestedAt)).toBeGreaterThanOrEqual(beforeRun)
    expect(Date.parse(snapshot.requestedAt)).toBeLessThanOrEqual(requestStarted)
    expect(Date.parse(snapshot.completedAt)).toBeGreaterThanOrEqual(requestFinished)
    expect(Date.parse(snapshot.completedAt)).toBeLessThanOrEqual(Date.now())
    expect(snapshot.rows).toEqual([{
      deviceId: 'asset-1', assetTag: 'TAG-1', hostname: 'host-1', department: 'Engineering', status: 'completed',
      target: 'minion', action: 'custom-state', state: 'patch.baseline', command: '', result: saltResult, rawResult: item,
      updatedItems: ['openssl'], packageChanges: [{ name: 'openssl', fromVersion: '1', toVersion: '2' }],
    }])
  })

  it.each([0, 400, 403, 500])('keeps execution output on report failure %s and retries only the unchanged snapshot', async status => {
    const item = { assetId: 'asset-1', status: 'failed', error: 'command returned 7', result: { target: 'minion', command: 'uptime', status: 'failed', result: { stdout: 'actual partial output', stderr: 'actual error', retcode: 7 }, historyRecorded: false } }
    let reportAttempts = 0
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/patch/dashboard') return Promise.resolve(jsonResponse({ total: 1, upToDate: 0, pending: 1, failed: 0, rebootPending: 0 }))
      if (path === '/api/patch/devices') return Promise.resolve(jsonResponse([{ id: 'asset-1', assetTag: 'TAG-1', hostname: 'host-1', patchStatus: 'pending', department: { name: 'Engineering' } }]))
      if (path === '/api/patch/batch') return Promise.resolve(jsonResponse({ targetCount: 1, results: [item] }))
      if (path === '/api/patch/reports' && init?.method === 'POST') {
        reportAttempts++
        if (reportAttempts === 1 && status === 0) return Promise.reject(new Error('report storage rejected snapshot'))
        return Promise.resolve(reportAttempts === 1 ? jsonResponse({ error: 'report storage rejected snapshot' }, status) : jsonResponse({ id: 'report-1' }, 201))
      }
      return Promise.resolve(jsonResponse([]))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<PatchPage />)
    expect(await screen.findByText('Live API')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Single System ID Execution' }))
    fireEvent.change(screen.getByLabelText('System ID'), { target: { value: '  TAG-1  ' } })
    fireEvent.click(screen.getByRole('button', { name: /cmd\.run.*diagnostic command/i }))
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '  uptime  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review cmd.run' }))
    fireEvent.click(screen.getByRole('button', { name: /confirm & run/i }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Report save failed: report storage rejected snapshot')
    expect(alert).toHaveTextContent('Do not rerun the remote operation')
    expect(screen.getByText('stdout: actual partial output')).toBeVisible()
    expect(screen.getByText('stderr: actual error')).toBeVisible()
    expect(screen.getByText('Exit code: 7')).toBeVisible()
    expect(screen.getByText('asset-1: FAILED · command returned 7')).toBeVisible()
    expect(screen.queryByText(/^ERROR:/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download snapshot JSON' })).toBeEnabled()
    // Refresh must not erase a save failure or reclassify it as execution failure.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled())
    expect(screen.getByRole('alert')).toHaveTextContent('Report save failed')
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'whoami' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry report save' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Retry report save' }))
    expect(await screen.findByText('Execution report saved.')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('stdout: actual partial output')).toBeVisible()
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/patch/batch')).toHaveLength(1)
    const reportCalls = fetchMock.mock.calls.filter(([path, init]) => path === '/api/patch/reports' && init?.method === 'POST')
    expect(reportCalls).toHaveLength(2)
    expect(reportCalls[1][1]?.body).toBe(reportCalls[0][1]?.body)
    const snapshot = JSON.parse(String(reportCalls[0][1]?.body))
    expect(snapshot.scopeLabel).toBe('System: TAG-1')
    expect(snapshot.rows[0]).toMatchObject({ deviceId: 'asset-1', command: 'uptime', state: '', error: 'command returned 7', stdout: 'actual partial output', stderr: 'actual error', retcode: 7, rawResult: item, result: item.result.result })
    expect(snapshot.rows[0]).not.toHaveProperty('packageChanges')
    expect(snapshot.rows[0]).not.toHaveProperty('updatedItems')
  })

  it.each(['empty', 'missing-id', 'execution-error'])('does not POST invalid or absent reports for %s responses', async kind => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/patch/dashboard') return Promise.resolve(jsonResponse({ total: 1, upToDate: 0, pending: 1, failed: 0, rebootPending: 0 }))
      if (path === '/api/patch/devices') return Promise.resolve(jsonResponse([{ id: 'asset-1', hostname: 'host-1', patchStatus: 'pending', department: { name: 'Engineering' } }]))
      if (path === '/api/patch/batch') return Promise.resolve(kind === 'execution-error' ? jsonResponse({ error: 'batch unavailable' }, 502) : jsonResponse({ targetCount: kind === 'empty' ? 0 : 1, results: kind === 'empty' ? [] : [{ assetId: '', status: 'completed' }] }))
      return Promise.resolve(jsonResponse([]))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<PatchPage />)
    expect(await screen.findByText('Live API')).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Review state.apply' }))
    fireEvent.click(screen.getByRole('button', { name: /confirm & run/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(kind === 'execution-error' ? 'batch unavailable' : 'Report not saved')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeEnabled())
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/patch/reports')).toBe(false)
    if (kind === 'empty') expect(screen.getByText('Matched 0 managed endpoint(s)')).toBeVisible()
  })

  it('loads deep links and synchronizes navigation with browser history', async () => {
    window.history.replaceState({}, '', '/patch/logs')
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/patch/dashboard') return Promise.resolve(jsonResponse({ total: 0, upToDate: 0, pending: 0, failed: 0, rebootPending: 0 }))
      if (path === '/api/patch/devices' || path === '/api/patch/reports') return Promise.resolve(jsonResponse([]))
      return Promise.resolve(jsonResponse({ items: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<PatchPage />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/patch/logs', expect.anything()))
    expect(screen.getByText('Patch execution logs')).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: 'Report' }))
    expect(window.location.pathname).toBe('/patch/reports')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/patch/reports', expect.anything()))
    window.history.replaceState({}, '', '/patch/alerts')
    fireEvent(window, new PopStateEvent('popstate'))
    expect(await screen.findByLabelText('Search patch alerts')).toBeVisible()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/patch/alerts', expect.anything()))
  })

  it('fetches report detail with authorization and refuses forbidden downloads', async () => {
    window.history.replaceState({}, '', '/patch/reports')
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input)
      if (path === '/api/patch/dashboard') return Promise.resolve(jsonResponse({ total: 0, upToDate: 0, pending: 0, failed: 0, rebootPending: 0 }))
      if (path === '/api/patch/devices') return Promise.resolve(jsonResponse([]))
      if (path === '/api/patch/reports') return Promise.resolve(jsonResponse([{ id: 'report-1', scopeLabel: 'Engineering', successCount: 1, failedCount: 0, rowCount: 1 }]))
      return Promise.resolve(jsonResponse({ error: 'forbidden' }, 403))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<PatchPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Download report report-1 JSON' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('forbidden')
    expect(fetchMock).toHaveBeenCalledWith('/api/patch/reports/report-1', expect.objectContaining({ headers: { Authorization: 'Bearer test-token' } }))
    expect(fetchMock.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method)).toBe(true)
  })

  it('does not backfill historical report rows with current directory asset tags', async () => {
    window.history.replaceState({}, '', '/patch/reports')
    const report = { id: 'report-1', scopeLabel: 'Historical execution', successCount: 1, failedCount: 0, rowCount: 1 }
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/patch/dashboard') return Promise.resolve(jsonResponse({ total: 1, upToDate: 1, pending: 0, failed: 0, rebootPending: 0 }))
      if (path === '/api/patch/devices') return Promise.resolve(jsonResponse([{ id: 'asset-1', assetTag: 'CURRENT-TAG', hostname: 'current-host', patchStatus: 'up_to_date' }]))
      if (path === '/api/patch/reports') return Promise.resolve(jsonResponse([report]))
      if (path === '/api/patch/reports/report-1') return Promise.resolve(jsonResponse({ ...report, rows: [{ deviceId: 'asset-1', status: 'completed', stdout: 'historical output' }] }))
      return Promise.resolve(jsonResponse({ error: 'not found' }, 404))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<PatchPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'View report report-1' }))
    const article = await screen.findByRole('article', { name: 'Report detail' })
    expect(article).toHaveTextContent('historical output')
    expect(article).not.toHaveTextContent('CURRENT-TAG')
    expect(article).not.toHaveTextContent('current-host')
    expect(article).not.toHaveTextContent('assetTag')
  })
})