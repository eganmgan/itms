import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PatchPage } from './PatchPage'

vi.mock('../components/SSHTerminal', () => ({ SSHTerminal: () => null }))

const devices = [
  { id: 'asset-1', hostname: 'host-1', patchStatus: 'pending', department: { name: 'Engineering' } },
  { id: 'asset-2', hostname: 'host-2', patchStatus: 'pending', department: { name: 'Finance' } },
]
const metrics = { total: 2, upToDate: 0, pending: 2, failed: 0, rebootPending: 0 }
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })

function mockWorkspace(overrides: { dashboard?: () => Promise<Response>; targets?: () => Promise<Response>; departments?: () => Promise<Response>; batch?: () => Promise<Response>; saveReport?: () => Promise<Response> } = {}) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    switch (String(input)) {
      case '/api/departments': return overrides.departments?.() ?? Promise.resolve(json([]))
      case '/api/patch/dashboard': return overrides.dashboard?.() ?? Promise.resolve(json(metrics))
      case '/api/patch/devices': return overrides.targets?.() ?? Promise.resolve(json(devices))
      case '/api/patch/batch': return overrides.batch?.() ?? Promise.resolve(json({ targetCount: 1, results: [{ assetId: 'asset-1', status: 'completed', result: { stdout: 'execution evidence', retcode: 0 } }] }))
      case '/api/patch/reports': return init?.method === 'POST' ? overrides.saveReport?.() ?? Promise.resolve(json({ id: 'report-1' })) : Promise.resolve(json([]))
      default: throw new Error(`Unexpected request: ${String(input)}`)
    }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function precedes(before: Element, after: Element) {
  expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
}

describe('PatchPage execution layout and readiness', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/patch')
    localStorage.setItem('itms_token', 'test-token')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it.each(['apt update', 'apt-get upgrade', 'sudo apt update'])('routes %s to an explicitly reviewed update state without sending a command', async command => {
    const fetchMock = mockWorkspace()
    render(<PatchPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Single System ID Execution' }))
    fireEvent.change(screen.getByLabelText('System ID'), { target: { value: 'TAG-1' } })
    fireEvent.click(screen.getByRole('button', { name: /cmd\.run.*Diagnostic command/ }))
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: command } })
    expect(screen.getByRole('alert')).toHaveTextContent('Package commands are blocked')
    expect(screen.getByRole('button', { name: 'Review cmd.run' })).toBeDisabled()
    const batches = () => fetchMock.mock.calls.filter(([path]) => path === '/api/patch/batch')
    fireEvent.click(screen.getByRole('button', { name: 'Use update state' }))
    expect(screen.getByLabelText('System ID')).toHaveValue('TAG-1')
    expect(screen.getByLabelText('Salt State')).toHaveValue('patch.baseline')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(batches()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Review state.apply' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('patch.baseline')
    expect(batches()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Run' }))
    await screen.findByText('Execution report saved.')
    expect(batches()).toHaveLength(1)
    expect(JSON.parse(String(batches()[0][1]?.body))).toMatchObject({ targetMode: 'system', systemId: 'TAG-1', action: 'custom-state', state: 'patch.baseline', command: '' })
  })

  it.each([true, false])('shows per-host changes and failures even when report saving succeeds: %s', async saved => {
    const missingState = "No matching sls found for 'patch.baseline' in env 'base'"
    const disconnected = 'salt minion is not connected to the master for this asset'
    mockWorkspace({
      batch: () => Promise.resolve(json({ targetCount: 3, results: [
        { assetId: 'asset-1', status: 'failed', error: missingState },
        { assetId: 'asset-2', status: 'failed', error: disconnected },
        { assetId: 'asset-3', status: 'failed', error: 'One state failed after package updates', result: { target: 'partial-host', result: { return: [{ 'partial-host': {
          'pkg_|-updates': { result: false, changes: { openssl: { old: '3.0.1', new: '3.0.2' } } },
          'pkg_|-preview': { result: null, changes: { predicted: { old: '1', new: '2' } } },
        } }] } } },
      ] })),
      saveReport: () => Promise.resolve(saved ? json({ id: 'report-1' }) : json({ error: 'Report service unavailable' }, 503)),
    })
    render(<PatchPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Review state.apply' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Run' }))
    const summary = await screen.findByRole('region', { name: 'Update results by hostname' })
    const rows = within(summary).getAllByRole('row')
    expect(rows[1]).toHaveTextContent(`host-1failedNo package changes recorded.${missingState}`)
    expect(rows[2]).toHaveTextContent(`host-2failedNo package changes recorded.${disconnected}`)
    expect(rows[3]).toHaveTextContent('partial-host')
    expect(rows[3]).toHaveTextContent('openssl3.0.1 -> 3.0.2')
    expect(rows[3]).toHaveTextContent('One state failed after package updates')
    expect(summary).not.toHaveTextContent('predicted')
    if (saved) expect(await screen.findByText('Execution report saved.')).toBeVisible()
    else expect(await screen.findByRole('alert')).toHaveTextContent('Report save failed')
    expect(summary).toBeVisible()
    localStorage.removeItem('itms_token')
    act(() => window.dispatchEvent(new Event('itms-auth-changed')))
    expect(screen.queryByRole('region', { name: 'Update results by hostname' })).not.toBeInTheDocument()
  })

  it('shows configured departments in Multiple even when no devices have a department', async () => {
    mockWorkspace({ targets: () => Promise.resolve(json(devices.map(device => ({ ...device, department: null })))),
      departments: () => Promise.resolve(json([{ name: 'IT Team' }, { name: 'Finance' }, { name: ' Finance ' }])) })
    render(<PatchPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Multiple Departments' }))
    const choices = screen.getByRole('group', { name: 'Departments' })
    expect(await within(choices).findByRole('checkbox', { name: 'IT Team' })).toBeVisible()
    expect(within(choices).getAllByRole('checkbox', { name: 'Finance' })).toHaveLength(1)
    fireEvent.click(within(choices).getByRole('checkbox', { name: 'IT Team' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Review state.apply' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('IT Team')
  })

  it('shows a department error and retains loaded device choices', async () => {
    mockWorkspace({ departments: () => Promise.resolve(json({ error: 'directory offline' }, 503)) })
    render(<PatchPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Multiple Departments' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Department directory unavailable')
    expect(await screen.findByRole('checkbox', { name: 'Engineering' })).toBeVisible()
  })

  it('shows an explicit empty state when no departments or device assignments exist', async () => {
    mockWorkspace({ targets: () => Promise.resolve(json([])) })
    render(<PatchPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Multiple Departments' }))
    expect(await screen.findByText('No departments available for your account.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeDisabled()
  })

  it.each([
    ['state.apply', 'departments'], ['state.apply', 'system'],
    ['cmd.run', 'departments'], ['cmd.run', 'system'],
  ])('arranges %s controls for %s before the responsive stream, retaining scoped review/confirm execution', async (kind, targetMode) => {
    const fetchMock = mockWorkspace()
    render(<PatchPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeEnabled())
    const controls = screen.getByRole('region', { name: 'Patch execution controls' })
    const operation = screen.getByRole('region', { name: 'Patch operation' })
    const stream = screen.getByRole('region', { name: 'Terminal execution stream' })
    expect(screen.getByRole('button', { name: 'Execute Console' })).toHaveClass('bg-brand-600', 'text-white')
    expect(controls.parentElement).toBe(operation.parentElement?.parentElement)
    expect(controls.nextElementSibling).toBe(operation.parentElement)
    expect(operation.nextElementSibling).toBe(stream)
    expect(controls.parentElement).toHaveClass('grid', 'grid-cols-1', 'min-w-0', 'lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]')
    expect(controls.parentElement?.className).not.toMatch(/order-/)
    const targetModes = screen.getByRole('group', { name: 'Target mode' })
    expect(targetModes).toHaveClass('grid-cols-2')
    expect(within(targetModes).getByRole('button', { name: 'Department-Wise Execution' })).toHaveClass('bg-brand-600', 'text-white')
    const selectionTypes = screen.getByRole('group', { name: 'Selection type' })
    expect(within(selectionTypes).getByRole('button', { name: 'Single Department' })).toHaveClass('bg-brand-600', 'text-white')
    const executionTypes = screen.getByRole('group', { name: 'Execution type' })
    expect(executionTypes).toHaveClass('grid-cols-3')
    expect(within(executionTypes).getByRole('button', { name: /state\.apply.*Salt state/ })).toHaveClass('min-h-12', 'p-1', 'bg-brand-600', 'text-white')
    expect(within(controls).getByRole('heading', { name: 'Targets' })).toBeVisible()
    expect(within(operation).getByRole('heading', { name: 'Operation' })).toBeVisible()
    expect(stream).toHaveClass('min-w-0')

    const targetButton = within(controls).getByRole('button', { name: targetMode === 'system' ? 'Single System ID Execution' : 'Department-Wise Execution' })
    fireEvent.click(targetButton)
    expect(targetButton).toHaveAttribute('aria-pressed', 'true')
    const targetInput = targetMode === 'system' ? screen.getByLabelText('System ID') : screen.getByLabelText('Department')
    fireEvent.change(targetInput, { target: { value: targetMode === 'system' ? '  host-1  ' : 'Finance' } })
    const kindButton = within(operation).getByRole('button', { name: kind === 'cmd.run' ? /cmd\.run.*Diagnostic command/ : /state\.apply.*Salt state/ })
    fireEvent.click(kindButton)
    expect(kindButton).toHaveAttribute('aria-pressed', 'true')
    const operationInput = screen.getByLabelText(kind === 'cmd.run' ? 'Command' : 'Salt State')
    const review = within(operation).getByRole('button', { name: `Review ${kind}` })
    if (kind === 'cmd.run') {
      expect(review).toBeDisabled()
      fireEvent.change(operationInput, { target: { value: '  uptime  ' } })
    } else fireEvent.change(operationInput, { target: { value: 'security.hardening' } })

    // Native tab sequence follows targeting -> operation -> review, with no CSS/tabindex reordering.
    const ordered = [targetButton, targetInput, kindButton, operationInput, review, stream]
    ordered.slice(1).forEach((element, index) => precedes(ordered[index], element))
    for (const element of [targetButton, targetInput]) expect(controls).toContainElement(element)
    for (const element of [kindButton, operationInput, review]) expect(operation).toContainElement(element)
    expect(controls.querySelector('[tabindex]')).toBeNull()
    expect(operation.querySelector('[tabindex]')).toBeNull()
    expect(review).toHaveClass('w-full', 'sm:w-auto')
    expect(review).toBeEnabled()
    expect(within(operation).getByText('Selected scope').parentElement).toHaveTextContent(targetMode === 'system' ? 'host-1' : 'Finance')
    const batches = () => fetchMock.mock.calls.filter(([path]) => path === '/api/patch/batch')
    expect(batches()).toHaveLength(0)
    fireEvent.click(review)
    let dialog = screen.getByRole('dialog', { name: 'Confirm patch execution' })
    expect(dialog).toHaveTextContent(targetMode === 'system' ? 'host-1' : 'Finance')
    expect(dialog).toHaveTextContent(kind === 'cmd.run' ? 'uptime' : 'security.hardening')
    expect(batches()).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(batches()).toHaveLength(0)
    fireEvent.click(review)
    dialog = screen.getByRole('dialog', { name: 'Confirm patch execution' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm & Run' }))
    expect(await within(stream).findByText('stdout: execution evidence')).toBeVisible()
    expect(await screen.findByText('Execution report saved.')).toBeVisible()
    expect(batches()).toHaveLength(1)
    const init = batches()[0][1]
    expect(init?.headers).toEqual({ Authorization: 'Bearer test-token', 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init?.body))).toMatchObject({
      targetMode,
      ...(targetMode === 'system' ? { systemId: 'host-1' } : { departments: ['Finance'] }),
      action: kind === 'cmd.run' ? 'custom-command' : 'custom-state',
      state: kind === 'cmd.run' ? '' : 'security.hardening',
      command: kind === 'cmd.run' ? 'uptime' : '',
    })
  })

  it.each(['state.apply', 'cmd.run'])('keeps all department selection variants above %s output and limited to loaded targets', async kind => {
    mockWorkspace()
    render(<PatchPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeEnabled())
    if (kind === 'cmd.run') {
      fireEvent.click(screen.getByRole('button', { name: /cmd\.run.*Diagnostic command/ }))
      fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'uptime' } })
    }
    const controls = screen.getByRole('region', { name: 'Patch execution controls' })
    const stream = screen.getByRole('region', { name: 'Terminal execution stream' })
    const selection = screen.getByRole('group', { name: 'Selection type' })
    expect(selection).toHaveClass('grid-cols-3')
    fireEvent.click(within(selection).getByRole('button', { name: 'Multiple Departments' }))
    const engineering = within(controls).getByRole('checkbox', { name: 'Engineering' })
    expect(engineering).toBeChecked()
    expect(within(controls).queryByRole('checkbox', { name: 'IT Infrastructure' })).not.toBeInTheDocument()
    fireEvent.click(engineering)
    expect(screen.getByRole('button', { name: `Review ${kind}` })).toBeDisabled()
    const finance = within(controls).getByRole('checkbox', { name: 'Finance' })
    fireEvent.click(finance)
    precedes(finance, stream)
    expect(screen.getByRole('button', { name: `Review ${kind}` })).toBeEnabled()
    fireEvent.click(within(selection).getByRole('button', { name: 'All Departments' }))
    precedes(within(controls).getByText('All 2 departments selected'), stream)
    const scope = within(screen.getByRole('region', { name: 'Patch operation' })).getByText('Selected scope').parentElement
    expect(scope).toHaveTextContent('Engineering')
    expect(scope).toHaveTextContent('Finance')
    expect(scope).not.toHaveTextContent('IT Infrastructure')
  })

  it.each(['pending', 'failed'])('does not block targets or execution on %s metrics', async state => {
    let finishMetrics!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { finishMetrics = resolve })
    mockWorkspace({ dashboard: () => state === 'pending' ? pending.then(response => response.clone()) : Promise.resolve(json({ error: 'metrics offline' }, 503)) })
    render(<PatchPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeEnabled())
    expect(screen.getByLabelText('Department')).toHaveValue('Engineering')
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled()
    const metricsRegion = screen.getByRole('region', { name: 'Patch metrics' })
    if (state === 'failed') expect(await within(metricsRegion).findByRole('alert')).toHaveTextContent('Metrics unavailable: metrics offline')
    expect(within(metricsRegion).getAllByText('-')).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: 'Review state.apply' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Run' }))
    expect(await screen.findByText('Execution report saved.')).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeEnabled())
    if (state === 'pending') {
      await act(async () => finishMetrics(json(metrics)))
      expect(within(metricsRegion).queryAllByText('-')).toHaveLength(0)
    }
  })

  it('never enables execution from metrics or configured departments when targets are denied', async () => {
    mockWorkspace({ targets: () => Promise.resolve(json({ error: 'targets forbidden' }, 403)), departments: () => Promise.resolve(json([{ name: 'Finance' }])) })
    render(<PatchPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Targets unavailable: targets forbidden')
    expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeDisabled()
    expect(await within(screen.getByLabelText('Department')).findByRole('option', { name: 'Finance' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Single System ID Execution' }))
    fireEvent.change(screen.getByLabelText('System ID'), { target: { value: 'host-1' } })
    expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeDisabled()
  })

  it('ignores stale target responses after sign-out and closes pending confirmation', async () => {
    let finishTargets!: (response: Response) => void
    let targetRequests = 0
    mockWorkspace({ targets: () => ++targetRequests === 1 ? Promise.resolve(json(devices)) : new Promise<Response>(resolve => { finishTargets = resolve }) })
    render(<PatchPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Review state.apply' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    localStorage.removeItem('itms_token')
    act(() => window.dispatchEvent(new Event('itms-auth-changed')))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await act(async () => finishTargets(json(devices)))
    expect(screen.getByText('API unavailable')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeDisabled()
    expect(within(screen.getByLabelText('Department')).queryAllByRole('option')).toHaveLength(0)
  })

  it('ignores late department responses after sign-out', async () => {
    let finishDepartments!: (response: Response) => void
    mockWorkspace({ departments: () => new Promise<Response>(resolve => { finishDepartments = resolve }) })
    render(<PatchPage />)
    expect(screen.getByText('Loading departments...')).toBeVisible()
    expect(screen.queryByText('No departments available for your account.')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeEnabled())
    localStorage.removeItem('itms_token')
    act(() => window.dispatchEvent(new Event('itms-auth-changed')))
    await act(async () => finishDepartments(json([{ name: 'Restricted department' }])))
    fireEvent.click(screen.getByRole('button', { name: 'Multiple Departments' }))
    expect(within(screen.getByRole('group', { name: 'Departments' })).queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Review state.apply' })).toBeDisabled()
  })

  it.each(['state.apply', 'cmd.run'])('keeps %s disabled without authentication', kind => {
    localStorage.clear()
    const fetchMock = mockWorkspace()
    render(<PatchPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Single System ID Execution' }))
    fireEvent.change(screen.getByLabelText('System ID'), { target: { value: 'host-1' } })
    if (kind === 'cmd.run') {
      fireEvent.click(screen.getByRole('button', { name: /cmd\.run.*Diagnostic command/ }))
      fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'uptime' } })
    }
    expect(screen.getByRole('button', { name: `Review ${kind}` })).toBeDisabled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})