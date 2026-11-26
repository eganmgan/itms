import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceOverviewPage } from './DeviceOverviewPage'
import type { DirectoryUser } from './DevicesPage'

const device: DirectoryUser = {
  id: 'owner-a', fullName: 'Stale directory owner', email: 'stale@example.test', employeeCode: 'E1',
  departmentName: 'Stale department', branchName: 'Stale location', assetCount: 1,
  newAssetCount: 0, ungroupedAssetCount: 0, flaggedAssetCount: 0, status: 'online', primaryAssetId: 'asset-a',
}
const inventory = {
  name: 'Recorded laptop', hostname: 'recorded-host', assetId: 'TAG-1', status: 'assigned',
  user: { fullName: 'Recorded owner', email: 'recorded@example.test', employeeCode: 'EMP-1' },
  technicianInCharge: { fullName: 'Recorded technician' }, groupInCharge: { name: 'Support group' },
  department: { name: 'Engineering' }, branch: { name: 'Recorded branch' }, supplier: { name: 'Recorded supplier' },
  osName: 'Linux', osVersion: '24.04.0', kernelVersion: '6.8.0', biosVersion: '1.03', osBuild: 0,
  cost: 0, complianceScore: 0, warrantyDurationMonths: 0, warrantyStartDate: '2026-01-31',
  warrantyExpiresAt: '2026-01-31', purchaseDate: '2025-12-30', updateSources: 'Managed repository',
  lastSeenAt: '2026-09-19T12:00:00Z', installedApps: [{ id: 'app', name: 'Recorded application', version: 0 }],
}
const ping = (connected: boolean | null = true, source = 'salt_ping', checked: string | null = '2026-09-19T12:01:00Z') => ({ connected, connectivitySource: source, connectivityCheckedAt: checked })
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }))
const refresh = () => fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
const requests = (suffix: string) => vi.mocked(fetch).mock.calls.filter(([url]) => new URL(String(url), 'http://localhost').pathname.endsWith(suffix))
const statusRegion = () => within(screen.getByRole('region', { name: 'Connectivity' }))
function changeAuth(token: string | null, storage = false) {
  act(() => {
    if (token) localStorage.setItem('itms_token', token)
    else localStorage.removeItem('itms_token')
    window.dispatchEvent(storage ? new StorageEvent('storage', { key: 'itms_token' }) : new Event('itms-auth-changed'))
  })
}
function visibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value })
  act(() => document.dispatchEvent(new Event('visibilitychange')))
}
function mockApi(overrides: (url: string, init?: RequestInit) => Promise<Response> | undefined = () => undefined) {
  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = new URL(String(input), 'http://localhost').pathname
    const override = overrides(url, init)
    if (override) return override
    if (url.endsWith('/connectivity')) return Promise.resolve(json(ping()))
    if (url.endsWith('/history') || url.endsWith('/alerts')) return Promise.resolve(json([]))
    return Promise.resolve(json(inventory))
  })
}
async function loaded() { await screen.findByRole('heading', { name: inventory.name }) }
function expectField(section: string, label: string, value: string) {
  const term = within(screen.getByRole('region', { name: section })).getByText(label, { selector: 'dt' })
  expect(term.nextElementSibling).toHaveTextContent(value)
}

beforeEach(() => {
  localStorage.clear(); localStorage.setItem('itms_token', 'account-a')
  vi.stubGlobal('fetch', vi.fn())
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  mockApi()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('actual device inventory', () => {
  it('shows inventory freshness and recorded services without issuing mutations', async () => {
    const fixtures: Record<string, unknown> = {
      '/api/auth/me': { id: 'owner-a', role: 'auditor' },
      '/api/devices/asset-a': { ...inventory, id: 'asset-a', entityId: 'entity-a',
        collectionStatus: { software: { status: 'failed' }, services: { status: 'partial', scanned_at: new Date().toISOString(), scope: 'system services' } },
        services: [{ name: 'example.service', state: 'running', start_mode: 'enabled', source: 'systemd' }],
      },
      '/api/software/permissions': { canInstall: false },
      '/api/assets/asset-a/services': { status: 'success', items: [], capabilities: { canManage: false } },
      '/api/assets/asset-a/management-actions': { items: [], capabilities: { canManage: false } },
      '/api/assets/asset-a/software-installs': { items: [], capabilities: { canInstall: false } },
      '/api/assets/asset-a/script-runs': { items: [], capabilities: { canApply: false } },
    }
    mockApi(url => url in fixtures ? Promise.resolve(new Response(JSON.stringify(fixtures[url]), { headers: { 'Content-Type': 'application/json' } })) : undefined)
    render(<DeviceOverviewPage device={device} />)
    await loaded()
    expectField('Inventory freshness', 'Applications list', 'Not updated - collection failed')
    expectField('Inventory freshness', 'Services list', 'Recently updated - partial inventory')
    tab('Services')
    expect(await screen.findByText('example.service')).toBeVisible()
    expect(screen.getByText('running')).toBeVisible()
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  })
  it('displays and copies actual IDs without remote launch or extra API calls', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    mockApi(url => url === '/api/devices/asset-a' ? Promise.resolve(json({ ...inventory, anydeskId: '001234567', rustdeskId: 0,
      macAddress: '02:00:00:00:00:01', network: { wired_ip: '192.0.2.10/24', wireless_ip: '192.0.2.11', netbird_ip: '100.64.0.10', gateway: '192.0.2.1', dns: '192.0.2.53',
        interface_stats: { eth0: { addresses: ['192.0.2.10'], mac: '02:00:00:00:00:01', state: 'DOWN', mtu: 0, rx_bytes: 0, password: 'PRIVATE_METADATA' } } },
    })) : undefined)
    render(<DeviceOverviewPage device={device} />)
    await loaded(); tab('System')
    expectField('Remote access', 'AnyDesk ID', '001234567')
    expectField('Remote access', 'RustDesk ID', '0')
    expectField('Network', 'Wired IP', '192.0.2.10/24')
    expectField('Network', 'Wireless IP', '192.0.2.11')
    expectField('Network', 'NetBird IP', '100.64.0.10')
    expectField('Network', 'MAC address', '02:00:00:00:00:01')
    expectField('Network', 'Gateway', '192.0.2.1')
    expectField('Network', 'DNS servers', '192.0.2.53')
    expectField('Network', 'Last inventory report', inventory.lastSeenAt)
    expectField('Interface eth0', 'Received bytes', '0')
    expectField('Interface eth0', 'Reported state', 'DOWN')
    expect(screen.getByText(/not a live network scan/)).toBeVisible()
    expect(screen.queryByText(/PRIVATE_METADATA/)).not.toBeInTheDocument()
    const count = vi.mocked(fetch).mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Copy AnyDesk ID' }))
    await screen.findByText('Copied')
    expect(writeText).toHaveBeenCalledWith('001234567')
    fireEvent.click(screen.getByRole('button', { name: 'Copy RustDesk ID' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('0'))
    expect(fetch).toHaveBeenCalledTimes(count)
    expect(screen.queryByRole('link', { name: /AnyDesk|RustDesk/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    writeText.mockRejectedValueOnce(new Error('denied'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy AnyDesk ID' }))
    expect(await screen.findByText('Copy unavailable. Select the ID to copy it.')).toBeVisible()
  })

  it.each([{}, { anydeskId: null, rustdeskId: '', network: null },
    { anydeskId: { password: 'PRIVATE_METADATA' }, rustdeskId: [], network: { interface_stats: [null, {}, 2] } }])('falls back for missing/malformed remote and network data %#', async fields => {
    mockApi(url => url === '/api/devices/asset-a' ? Promise.resolve(json({ ...inventory, ...fields })) : undefined)
    render(<DeviceOverviewPage device={device} />)
    await loaded(); tab('System')
    expectField('Remote access', 'AnyDesk ID', 'Not recorded')
    expectField('Remote access', 'RustDesk ID', 'Not recorded')
    expectField('Network', 'Wired IP', 'Not recorded')
    expectField('Network interfaces', 'Interface statistics', 'Not recorded')
    expect(screen.queryByRole('button', { name: /Copy .* ID/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/PRIVATE_METADATA|\[object Object\]/)).not.toBeInTheDocument()
  })

  it('Refresh updates stored network and IDs immediately while connectivity never resolves', async () => {
    const connection = deferred<Response>()
    let version = 0
    mockApi(url => url.endsWith('/connectivity') ? connection.promise : url === '/api/devices/asset-a' ? Promise.resolve(json({ ...inventory,
      anydeskId: version ? '987654321' : '123456789', network: { wired_ip: version ? '192.0.2.20' : '192.0.2.10', interface_stats: version ? [{ name: 'en0', addresses: ['192.0.2.20'], hardware_port: 'Wi-Fi' }] : {} },
      lastSeenAt: version ? '2026-09-19T13:00:00Z' : inventory.lastSeenAt,
    })) : undefined)
    render(<DeviceOverviewPage device={device} />)
    await screen.findByRole('heading', { name: inventory.name }); tab('System')
    expectField('Network', 'Wired IP', '192.0.2.10')
    version = 1; refresh()
    await screen.findByText('987654321')
    expectField('Network', 'Wired IP', '192.0.2.20')
    expectField('Network', 'Last inventory report', '2026-09-19T13:00:00Z')
    expectField('Interface en0', 'Hardware port', 'Wi-Fi')
    expect(screen.getByText('Checking connectivity…')).toBeVisible()
    expect(requests('/asset-a')).toHaveLength(2)
    expect(requests('/asset-a').every(([, init]) => init?.cache === 'no-store' && !init.method)).toBe(true)
    changeAuth('account-b')
    expect(screen.queryByText('987654321')).not.toBeInTheDocument()
    expect(screen.queryByText('192.0.2.20')).not.toBeInTheDocument()
  })

  it('does not request or expose identity while signed out, and offers sign-in navigation', () => {
    localStorage.removeItem('itms_token')
    const signIn = vi.fn()
    window.addEventListener('itms-open-sign-in', signIn)
    render(<DeviceOverviewPage device={device} />)
    expect(screen.getByRole('heading', { name: 'Sign-in required' })).toBeVisible()
    expect(screen.queryByText(/Daniella|SYS-7714|Stale directory|Online/)).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(signIn).toHaveBeenCalledOnce()
    window.removeEventListener('itms-open-sign-in', signIn)
  })

  it.each([null, { ...device, primaryAssetId: undefined }])('does not invent a device when selection is missing', selection => {
    render(<DeviceOverviewPage device={selection} />)
    expect(screen.getByRole('heading', { name: 'No device selected' })).toBeVisible()
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.queryByText(/Daniella|SYS-7714|Workstation/)).not.toBeInTheDocument()
  })

  it('maps fullName, distinct group/department, zero costs/duration and exact dates/versions', async () => {
    render(<DeviceOverviewPage device={device} />)
    await loaded()
    expectField('Assignment', 'User', 'Recorded owner')
    expect(screen.queryByText(device.fullName)).not.toBeInTheDocument()
    expectField('Inventory overview', 'Compliance', '0%')
    tab('System')
    expectField('Computer Details', 'Technician in Charge', 'Recorded technician')
    expectField('Computer Details', 'Group in Charge', 'Support group')
    expectField('Computer Details', 'Department', 'Engineering')
    expectField('Computer Details', 'User', 'Recorded owner')
    expectField('Computer Details', 'Update Sources', 'Managed repository')
    expectField('Computer Details', 'Asset Status', 'assigned')
    expectField('Financial & Administrative Information', 'Value (INR)', '0')
    expectField('Warranty Information', 'Warranty Duration', '0 months')
    expectField('Warranty Information', 'Warranty Start Date', '2026-01-31')
    expectField('Warranty Information', 'Warranty Expiry Date', '2026-01-31')
    expectField('Management - Asset Lifecycle', 'Date of Purchase', '2025-12-30')
    expectField('Operating System', 'Version', '24.04.0')
    expectField('Operating System', 'Build', '0')
    expectField('Operating System', 'Kernel Version', '6.8.0')
    expectField('Operating System', 'BIOS Version', '1.03')
    expect(screen.getByRole('tab', { name: 'Apps' })).toBeVisible()
    expect(screen.queryByRole('tab', { name: 'Applications' })).not.toBeInTheDocument()
  })

  it('shows absent data as Not recorded without copying department into group or fabricating telemetry', async () => {
    mockApi(url => url === '/api/devices/asset-a' ? Promise.resolve(json({ department: { name: 'Actual department' }, user: { name: 'Wrong legacy name' } })) : undefined)
    render(<DeviceOverviewPage device={device} />)
    await screen.findByText('Actual department')
    expectField('Inventory overview', 'Compliance', 'Not recorded')
    expectField('Assignment', 'User', 'Not recorded')
    tab('System')
    expectField('Computer Details', 'Group in Charge', 'Not recorded')
    expectField('Warranty Information', 'Warranty Duration', 'Not recorded')
    expectField('Operating System', 'Version', 'Not recorded')
    expect(screen.queryByText(/Wrong legacy name|Daniella|Workstation|IT Infrastructure/)).not.toBeInTheDocument()
  })

  it('keeps detail and connectivity independent and Refresh immediately reloads both', async () => {
    const detail = deferred<Response>()
    mockApi(url => url === '/api/devices/asset-a' ? detail.promise : undefined)
    render(<DeviceOverviewPage device={device} />)
    expect(await statusRegion().findByText('Online')).toBeVisible()
    expect(screen.getByText('Loading device details…')).toBeVisible()
    const oldSignal = requests('/asset-a')[0][1]!.signal
    mockApi()
    refresh()
    expect(oldSignal?.aborted).toBe(true)
    await loaded()
    expect(requests('/connectivity')).toHaveLength(2)
    expect(requests('/asset-a')).toHaveLength(2)
    await act(async () => detail.resolve(json({ name: 'Late superseded detail' })))
    expect(screen.queryByText('Late superseded detail')).not.toBeInTheDocument()
  })
})

describe('lazy tab requests', () => {
  it('only requests the selected Alerts/History tab, not other tabs or polling inventory', async () => {
    render(<DeviceOverviewPage device={device} />)
    await loaded()
    for (const name of ['System', 'Services', 'Updates', 'Overview']) tab(name)
    expect(requests('/alerts')).toHaveLength(0)
    expect(requests('/history')).toHaveLength(0)
    tab('Alerts')
    expect(await screen.findByText('No endpoint alerts.')).toBeVisible()
    expect(requests('/history')).toHaveLength(0)
    tab('History')
    expect(await screen.findByText('No endpoint history.')).toBeVisible()
    expect(requests('/alerts')).toHaveLength(1)
    expect(requests('/history')).toHaveLength(1)
    expect(requests('/asset-a')).toHaveLength(1)
    refresh()
    await waitFor(() => expect(requests('/history')).toHaveLength(2))
    expect(requests('/alerts')).toHaveLength(1)
  })

  it('aborts a deselected tab and rejects its late response even on return to that tab', async () => {
    const late = deferred<Response>()
    let count = 0
    mockApi(url => url.endsWith('/history') && count++ === 0 ? late.promise : undefined)
    render(<DeviceOverviewPage device={device} />)
    await loaded()
    tab('History')
    expect(screen.getByText('Loading history…')).toBeVisible()
    const signal = requests('/history')[0][1]!.signal
    tab('Alerts')
    expect(signal?.aborted).toBe(true)
    tab('History')
    await screen.findByText('No endpoint history.')
    await act(async () => late.resolve(json([{ action: 'Late history from deselected tab' }])))
    expect(screen.queryByText('Late history from deselected tab')).not.toBeInTheDocument()
  })

  it.each(['Alerts', 'History'])('does not label a failed %s request as empty or erase details', async name => {
    mockApi(url => url.endsWith(`/${name.toLowerCase()}`) ? Promise.resolve(json({}, 500)) : undefined)
    render(<DeviceOverviewPage device={device} />)
    await loaded(); tab(name)
    expect(await screen.findByText(new RegExp(`${name} unavailable`))).toBeVisible()
    expect(screen.queryByText(new RegExp(`No endpoint ${name.toLowerCase()}`))).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: inventory.name })).toBeVisible()
  })
})

describe('live connectivity', () => {
  it('shows backend heartbeat without making an additional status request', async () => {
    mockApi(url => url.endsWith('/connectivity') ? Promise.resolve(json({
      connected: true, connectivitySource: 'agent_heartbeat', connectivityCheckedAt: '2026-09-29T09:00:30Z', lastHeartbeatAt: '2026-09-29T09:00:00Z',
    })) : undefined)
    render(<DeviceOverviewPage device={device} />)
    await statusRegion().findByText('Online')
    expect(statusRegion().queryByText('Checking connectivity…')).not.toBeInTheDocument()
    expect(statusRegion().getByText('Last heartbeat: 2026-09-29T09:00:00Z')).toBeVisible()
    expect(requests('/connectivity')).toHaveLength(1)
  })

  it('times out a stalled backend status request and retries only on manual Refresh', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const stalled = deferred<Response>()
    mockApi(url => url.endsWith('/connectivity') ? stalled.promise : undefined)
    render(<DeviceOverviewPage device={device} />)
    await act(async () => vi.advanceTimersByTime(8_000))
    expect(statusRegion().getByText(/Backend status request timed out/)).toBeVisible()
    expect(statusRegion().queryByText('Checking connectivity…')).not.toBeInTheDocument()
    expect(requests('/connectivity')[0][1]?.signal?.aborted).toBe(true)
    mockApi()
    await act(async () => vi.advanceTimersByTime(7_000))
    expect(requests('/connectivity')).toHaveLength(1)
    await act(async () => refresh())
    expect(statusRegion().getByText('Online')).toBeVisible()
  })

  it('shows online heartbeat when the response includes unavailable Salt status', async () => {
    mockApi(url => url.endsWith('/connectivity') ? Promise.resolve(json({
      connected: true, connectivitySource: 'agent_heartbeat', connectivityCheckedAt: '2026-09-29T09:00:30Z', lastHeartbeatAt: '2026-09-29T09:00:00Z', salt: ping(null, 'salt_unavailable'),
    })) : undefined)
    render(<DeviceOverviewPage device={device} />)
    await statusRegion().findByText('Online')
    expect(statusRegion().getByText('Last heartbeat: 2026-09-29T09:00:00Z')).toBeVisible()
    expect(requests('/connectivity')).toHaveLength(1)
  })

  it('loads status once without polling or focus/visibility refresh and supports manual Refresh', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const view = render(<DeviceOverviewPage device={device} />)
    await loaded()
    await act(async () => vi.advanceTimersByTime(14_999))
    expect(requests('/connectivity')).toHaveLength(1)
    await act(async () => vi.advanceTimersByTime(1))
    expect(requests('/connectivity')).toHaveLength(1)
    expect(requests('/asset-a')).toHaveLength(1)
    expect(requests('/alerts')).toHaveLength(0)
    act(() => window.dispatchEvent(new Event('focus')))
    expect(requests('/connectivity')).toHaveLength(1)
    visibility('hidden')
    await act(async () => vi.advanceTimersByTime(45_000))
    act(() => window.dispatchEvent(new Event('focus')))
    expect(requests('/connectivity')).toHaveLength(1)
    expect(statusRegion().getByText('Online')).toBeVisible()
    visibility('visible')
    expect(requests('/connectivity')).toHaveLength(1)
    refresh()
    await waitFor(() => expect(requests('/connectivity')).toHaveLength(2))
    view.unmount()
    await act(async () => vi.advanceTimersByTime(30_000))
    act(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
    expect(requests('/connectivity')).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('loads backend status once even when initially hidden', async () => {
    visibility('hidden')
    render(<DeviceOverviewPage device={device} />)
    await loaded()
    expect(requests('/connectivity')).toHaveLength(1)
    visibility('visible')
    await loaded()
    expect(requests('/connectivity')).toHaveLength(1)
  })

  it('does not poll a pending request; explicit Refresh supersedes and rejects a late response', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const late = deferred<Response>()
    mockApi(url => url.endsWith('/connectivity') ? late.promise : undefined)
    render(<DeviceOverviewPage device={device} />)
    await screen.findByRole('heading', { name: inventory.name })
    await act(async () => vi.advanceTimersByTime(30_000))
    expect(requests('/connectivity')).toHaveLength(1)
    const signal = requests('/connectivity')[0][1]!.signal
    mockApi(url => url.endsWith('/connectivity') ? Promise.resolve(json(ping(false))) : undefined)
    refresh()
    expect(signal?.aborted).toBe(true)
    await statusRegion().findByText('Offline')
    await act(async () => late.resolve(json(ping(true))))
    expect(statusRegion().getByText('Offline')).toBeVisible()
  })

  it('transitions online to offline to unknown to online without issuing mutations', async () => {
    let connection = ping(true)
    mockApi(url => url.endsWith('/connectivity') ? Promise.resolve(json(connection)) : undefined)
    render(<DeviceOverviewPage device={device} />)
    await loaded()
    connection = ping(false)
    refresh()
    await statusRegion().findByText('Offline')
    connection = ping(null, 'salt_unavailable')
    refresh()
    await statusRegion().findByText('Unknown')
    connection = ping(true)
    refresh()
    await statusRegion().findByText('Online')
    expect(requests('/connectivity')).toHaveLength(4)
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
  })

  it.each(['salt_unavailable', 'salt_unconfigured', 'unmanaged'])('shows %s as unknown despite fresh inventory and online directory status', async source => {
    mockApi(url => url.endsWith('/connectivity') ? Promise.resolve(json(ping(null, source, null))) : undefined)
    render(<DeviceOverviewPage device={device} />)
    await screen.findByRole('heading', { name: inventory.name })
    await waitFor(() => expect(statusRegion().queryByText('Checking connectivity…')).not.toBeInTheDocument())
    expect(statusRegion().getByText('Unknown')).toBeVisible()
    tab('Updates')
    expect(screen.getByRole('heading', { name: 'Pending updates' })).toBeVisible()
  })

  it.each(['http', 'network', 'malformed'])('clears previous online status on %s failure without hiding inventory', async failure => {
    render(<DeviceOverviewPage device={device} />)
    await loaded()
    mockApi(url => url.endsWith('/connectivity') ? failure === 'network' ? Promise.reject(new Error('Network unavailable')) : Promise.resolve(failure === 'http' ? json({}, 503) : json({ ...ping(), connected: 'true' })) : undefined)
    refresh()
    await screen.findByText(/Connectivity unavailable/)
    expect(statusRegion().getByText('Unknown')).toBeVisible()
    expect(screen.getByRole('heading', { name: inventory.name })).toBeVisible()
  })
})

describe('request isolation and access boundaries', () => {
  it.each([
    ['device', 'Alerts'], ['account', 'Alerts'], ['logout', 'Alerts'],
    ['device', 'History'], ['account', 'History'], ['logout', 'History'],
  ])('aborts all loads and ignores late successes after %s switch on %s', async (kind, selectedTab) => {
    const detail = deferred<Response>(), connection = deferred<Response>(), alerts = deferred<Response>()
    mockApi(url => url.endsWith(`/${selectedTab.toLowerCase()}`) ? alerts.promise : url.endsWith('/connectivity') ? connection.promise : detail.promise)
    const view = render(<DeviceOverviewPage device={device} />)
    tab(selectedTab)
    const signals = vi.mocked(fetch).mock.calls.map(([, init]) => init!.signal!)
    mockApi(url => url.endsWith('/connectivity') ? Promise.resolve(json(ping(false))) : url.startsWith('/api/devices/') ? Promise.resolve(json({ name: 'New scoped device' })) : undefined)
    if (kind === 'device') view.rerender(<DeviceOverviewPage device={{ ...device, id: 'owner-b', primaryAssetId: 'asset-b' }} />)
    else changeAuth(kind === 'logout' ? null : 'account-b', true)
    signals.forEach(signal => expect(signal.aborted).toBe(true))
    await act(async () => {
      detail.resolve(json({ name: 'Late private inventory' }))
      connection.resolve(json(ping(true)))
      alerts.resolve(json([{ title: 'Late private alert', action: 'Late private history' }]))
    })
    expect(screen.queryByText(/Late private/)).not.toBeInTheDocument()
    if (kind === 'logout') expect(screen.getByRole('heading', { name: 'Sign-in required' })).toBeVisible()
    else {
      expect(await screen.findByRole('heading', { name: 'New scoped device' })).toBeVisible()
      expect(statusRegion().getByText('Offline')).toBeVisible()
      expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
    }
  })

  it('clears loaded identity immediately on account change and logout', async () => {
    render(<DeviceOverviewPage device={device} />)
    await loaded()
    const next = deferred<Response>()
    mockApi(() => next.promise)
    changeAuth('account-b')
    expect(screen.queryByText('Recorded owner')).not.toBeInTheDocument()
    expect(screen.queryByText(device.fullName)).not.toBeInTheDocument()
    expect(statusRegion().getByText('Unknown')).toBeVisible()
    changeAuth(null)
    expect(screen.getByRole('heading', { name: 'Sign-in required' })).toBeVisible()
  })

  it('rejects a late body parse after account switch, including after switching back', async () => {
    const body = deferred<unknown>()
    const parse = vi.fn(() => body.promise)
    mockApi(url => url === '/api/devices/asset-a' ? Promise.resolve({ ok: true, status: 200, json: parse } as unknown as Response) : undefined)
    render(<DeviceOverviewPage device={device} />)
    await waitFor(() => expect(parse).toHaveBeenCalled())
    mockApi()
    changeAuth('account-b'); changeAuth('account-a')
    await loaded()
    await act(async () => body.resolve({ name: 'Old parsed identity' }))
    expect(screen.queryByText('Old parsed identity')).not.toBeInTheDocument()
  })

  it.each([401, 403])('revokes displayed data and stops polling on HTTP %s', async code => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    render(<DeviceOverviewPage device={device} />)
    await loaded()
    mockApi(url => url.endsWith('/alerts') ? Promise.resolve(json({}, code)) : undefined)
    tab('Alerts')
    expect(await screen.findByRole('heading', { name: 'Device unavailable' })).toBeVisible()
    expect(screen.queryByText('Recorded owner')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    const count = vi.mocked(fetch).mock.calls.length
    await act(async () => vi.advanceTimersByTime(30_000))
    act(() => window.dispatchEvent(new Event('focus')))
    expect(fetch).toHaveBeenCalledTimes(count)
  })

  it('aborts all requests on unmount and ignores late failures', async () => {
    const pending = deferred<Response>()
    mockApi(() => pending.promise)
    const view = render(<DeviceOverviewPage device={device} />)
    tab('History')
    const signals = vi.mocked(fetch).mock.calls.map(([, init]) => init!.signal!)
    view.unmount()
    signals.forEach(signal => expect(signal.aborted).toBe(true))
    await act(async () => pending.reject(new Error('Late failure')))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('handles StrictMode setup/cleanup without accepting the aborted first mount', async () => {
    render(<StrictMode><DeviceOverviewPage device={device} /></StrictMode>)
    await loaded()
    expect(requests('/asset-a')[0][1]!.signal?.aborted).toBe(true)
    expect(requests('/connectivity')[0][1]!.signal?.aborted).toBe(true)
    expect(requests('/history')).toHaveLength(0)
  })

})