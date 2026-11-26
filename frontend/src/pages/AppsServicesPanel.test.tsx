import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppsServicesPanel } from './AppsServicesPanel'
import { PatchPage } from './PatchPage'
import { DeviceOverviewPage } from './DeviceOverviewPage'
import { journalKey, type ActionRecord } from '../lib/appsServices'

vi.mock('../components/SSHTerminal', () => ({ SSHTerminal: () => null }))
const assetId = '11111111-1111-4111-8111-111111111111'
const asset2 = '22222222-2222-4222-8222-222222222222'
const entityId = '33333333-3333-4333-8333-333333333333'
const applicationId = '44444444-4444-4444-8444-444444444444'
const requestId = '55555555-5555-4555-8555-555555555555'
const savedScript = { id: applicationId, entityId, name: 'Install example service', category: 'service', type: 'sh', os: 'Ubuntu', description: 'Reviewed service installer', hash: 'a'.repeat(64), body: 'echo example' }
const devices = [{ id: assetId, hostname: 'fixture-one', assetTag: 'FIX-1' }, { id: asset2, hostname: 'fixture-two', assetTag: 'FIX-2' }]
const application = { id: applicationId, entityId, name: 'Approved fixture app', packageName: 'fixture-package', os: 'linux', active: true }
const capabilities = { canInstall: true, canManageCatalog: false, canManage: true }
// /auth/me is the flat userAuthPayload, not JWT claims or { user: ... }.
const authUser = { id: 'actor-fixture', role: 'it_team', emp_id: 'FIXTURE', email: 'fixture@example.test', full_name: 'Fixture User', entity_id: entityId, dept_id: null, location_id: null, default_portal: '/it/dashboard', portals: ['it_team', 'employee'] }
const detail = {
  id: assetId, entityId, hostname: 'fixture-one', assetTag: 'FIX-1', osName: 'Ubuntu 24.04', lastSeenAt: '2026-09-20T01:00:00Z',
  installedApps: [{ name: 'Recorded fixture app', version: '1.2', source: 'dpkg_desktop' }, { name: 'fixture-package', source: 'dpkg_desktop' }, { name: 'libsystem', source: 'dpkg' }],
  services: [{ name: 'fixture.service', display_name: 'Fixture service', state: 'running', start_mode: 'enabled', source: 'systemd' }],
  servicesLastSuccessAt: '2026-09-19T01:00:00Z', servicesUpdatedAt: '2026-09-20T01:00:00Z',
  collectionStatus: { software: { status: 'partial', source: 'dpkg', scope: 'system packages only', scanned_at: '2026-09-20T01:00:00Z', total: 2, returned: 1, truncated: true, truncated_count: 1 }, services: { status: 'failed', source: 'systemd', error: 'collection unavailable' } },
}
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
type Override = (path: string, init?: RequestInit) => Promise<Response> | Response | undefined
function setup(override?: Override) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input)
    const replacement = override?.(path, init)
    if (replacement) return replacement
    if (path === '/api/auth/me') return json(authUser)
    if (path === '/api/devices') return json(devices)
    if (path === '/api/patch/devices') return json(devices)
    if (path === '/api/patch/dashboard') return json({ total: 2, upToDate: 0, pending: 2, failed: 0, rebootPending: 0 })
    if (path === `/api/devices/${assetId}`) return json(detail)
    if (path === `/api/devices/${asset2}`) return json({ ...detail, id: asset2, hostname: 'fixture-two', assetTag: 'FIX-2', installedApps: [{ name: 'Second inventory', source: 'dpkg_desktop' }, { name: 'fixture-package', source: 'dpkg_desktop' }] })
    if (path === '/api/software/permissions') return json(capabilities)
    if (path.endsWith('/software-approvals')) return json({ items: ['install', 'remove'].map(action => ({ id: action === 'install' ? requestId : asset2, ticketNumber: 'TKT-001', applicationId, packageName: 'fixture-package', action, approvedAt: '2026-09-30T01:00:00Z', requestId: '', available: true })), canApprove: false })
    if (path.startsWith('/api/software/vendor-versions?')) return json({ items: {} })
    if (path.includes('/installation-scripts?')) return json({ items: [], page: 1, hasMore: false, capabilities: { canApply: false } })
    if (path.includes('/script-runs')) return json({ items: [], capabilities: { canApply: false } })
    if (path.startsWith('/api/software/catalog?')) return json({ items: [application], capabilities, page: 1, hasMore: false })
    if (path.endsWith('/services')) return json({ items: [{ name: 'fixture.service', running: null, enabled: null }], status: 'partial', capabilities, error: 'service states unavailable; names may be incomplete' })
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      const record = { ...body, assetId, status: 'succeeded', outcomeCode: 'verified', createdAt: '2026-09-21T01:00:00Z', updatedAt: '2026-09-21T01:00:00Z' }
      return json(path.endsWith('/software-install') ? { install: record } : { items: [record], capabilities })
    }
    if (path.includes('/management-actions') || path.includes('/software-installs')) return json({ items: [], capabilities })
    throw new Error(`Unexpected fixture URL: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
async function selectDevice(id = assetId) {
  await waitFor(() => expect(screen.queryByLabelText('Device') || screen.queryByRole('button', { name: `Apps for ${id === assetId ? 'fixture-one' : 'fixture-two'}` })).toBeEnabled())
  if (screen.queryByLabelText('Device')) fireEvent.change(screen.getByLabelText('Device'), { target: { value: id } })
  else fireEvent.click(screen.getByRole('button', { name: `Apps for ${id === assetId ? 'fixture-one' : 'fixture-two'}` }))
  await screen.findByRole('region', { name: 'Approved applications' })
  await screen.findByRole('option', { name: /Approved fixture app/ })
}
async function selectPackage() {
  fireEvent.change(screen.getByLabelText('Approved package'), { target: { value: applicationId } })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review install' })).toBeEnabled())
}
async function confirm(action = 'install') {
  fireEvent.click(screen.getByRole('button', { name: action === 'install' ? 'Review install' : action === 'remove' ? 'Review remove' : 'Review service action' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
}
const mutations = (fetchMock: ReturnType<typeof setup>) => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')

function setupCatalog(override?: Override) {
  return setup((path, init) => {
    const replacement = override?.(path, init)
    if (replacement) return replacement
    if (path === '/api/auth/me') return json({ ...authUser, role: 'super_admin', default_portal: '/admin/dashboard', portals: ['super_admin', 'it_team', 'employee'] })
    if (path === '/api/software/permissions') return json({ ...capabilities, canManageCatalog: true })
    if (path === '/api/software/catalog' && init?.method === 'POST') return json({ id: 'new-application', ...JSON.parse(String(init.body)) }, 201)
    return undefined
  })
}
async function openCatalogForm() {
  await selectDevice()
  fireEvent.click(await screen.findByRole('button', { name: 'Add approved application' }))
}
function fillCatalogForm(description = '') {
  fireEvent.change(screen.getByLabelText('Application name'), { target: { value: 'New approved application' } })
  fireEvent.change(screen.getByLabelText('Package identifier'), { target: { value: 'Vendor.App_1+2-3' } })
  fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: description } })
  fireEvent.click(screen.getByLabelText('I approve this exact package for this entity and OS.'))
}

function setupScripts(override?: Override) {
  return setupCatalog((path, init) => {
    const replacement = override?.(path, init)
    if (replacement) return replacement
    if (path.includes('/installation-scripts?')) return json({ items: [savedScript], page: 1, hasMore: false, capabilities: { canApply: true } })
    if (path.endsWith(`/installation-scripts/${applicationId}`)) return json(savedScript)
    if (path.includes('/script-runs')) {
      if (init?.method === 'POST') return json({ run: { ...JSON.parse(String(init.body)), assetId, scriptName: savedScript.name, category: 'service', status: 'succeeded', outcomeCode: 'script_exited_zero', createdAt: '2026-09-22T12:00:00Z', updatedAt: '2026-09-22T12:00:00Z' } })
      return json({ items: [], capabilities: { canApply: true } })
    }
    return undefined
  })
}

async function reviewSavedScript() {
  await selectDevice()
  fireEvent.change(await screen.findByLabelText('Installation script'), { target: { value: applicationId } })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review installation script' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Review installation script' }))
  return screen.findByRole('dialog', { name: 'Confirm endpoint action' })
}

describe('Apps & Services', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('itms_token', 'fixture-token'); window.history.replaceState({}, '', '/patch/apps-services'); vi.spyOn(crypto, 'randomUUID').mockReturnValue(requestId) })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear() })

  it('binds device Apps to the exact asset without fetching the directory or services', async () => {
    const fetchMock = setup()
    render(<AppsServicesPanel assetId={assetId} appsOnly systemView />)
    await screen.findByRole('region', { name: 'Recorded applications' })
    expect(screen.getByRole('columnheader', { name: 'Latest vendor version' })).toBeVisible()
    expect(screen.queryByLabelText('Device')).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Live service controls' })).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/devices' || String(url).endsWith('/services'))).toBe(false)
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it('binds device Services without showing application or script controls', async () => {
    const fetchMock = setup()
    render(<AppsServicesPanel assetId={assetId} servicesOnly />)
    await screen.findByRole('region', { name: 'Live service controls' })
    expect(screen.getByRole('region', { name: 'Recorded services' })).toHaveTextContent('fixture.service')
    expect(screen.queryByRole('region', { name: 'Recorded applications' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Approved applications' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Installation scripts' })).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/devices' || String(url).includes('/software/catalog') || String(url).endsWith('/software-approvals'))).toBe(false)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh services' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Refresh services' }))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === `/api/devices/${assetId}`)).toHaveLength(2))
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === `/api/assets/${assetId}/services`).length).toBeGreaterThan(1))
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it.each(['missing', 'used', 'wrong package', 'wrong application', 'unavailable'])('blocks app mutations with %s ticket approval', async condition => {
    const fetchMock = setup(path => path.endsWith('/software-approvals') ? condition === 'unavailable' ? json({ error: 'Approval read failed' }, 503) : json({ items: condition === 'missing' ? [] : ['install', 'remove'].map(action => ({ id: `${requestId}-${action}`, ticketNumber: 'TKT-001', applicationId: condition === 'wrong application' ? asset2 : applicationId, packageName: condition === 'wrong package' ? 'other-app' : 'fixture-package', action, approvedAt: '2026-09-30T01:00:00Z', requestId: condition === 'used' ? requestId : '', available: condition !== 'used' })), canApprove: false }) : undefined)
    render(<AppsServicesPanel appsOnly systemView />)
    await selectDevice()
    fireEvent.change(screen.getByLabelText('Approved package'), { target: { value: applicationId } })
    expect(screen.getByRole('button', { name: 'Review install' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Review remove' })).toBeDisabled()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it('shows installed and latest vendor versions alongside linked approval tickets', async () => {
    setup(path => {
      if (path === `/api/devices/${assetId}`) return json({ ...detail, installedApps: [...detail.installedApps, { name: 'firefox', version: '155.0', source: 'snap_desktop' }] })
      if (path.startsWith('/api/software/vendor-versions?')) return json({ items: { firefox: { version: '157.0', sourceUrl: 'https://product-details.mozilla.org/1.0/firefox_versions.json', checkedAt: '2026-09-30T01:00:00Z', status: 'available' } } })
      return undefined
    })
    render(<AppsServicesPanel appsOnly systemView />)
    await selectDevice()
    const apps = within(screen.getByRole('region', { name: 'Recorded applications' }))
    expect(await apps.findByRole('link', { name: '157.0' })).toHaveAttribute('href', 'https://product-details.mozilla.org/1.0/firefox_versions.json')
    expect(apps.getByText('155.0')).toBeVisible()
    expect(apps.getByText('TKT-001 (install, approved)')).toBeVisible()
    expect(apps.getByRole('columnheader', { name: 'Approval ticket number' })).toBeVisible()
    expect(apps.getAllByText('Unavailable').length).toBeGreaterThan(0)
  })

  it('requires explicit ticket approval and does not install software while approving', async () => {
    const fetchMock = setupCatalog((path, init) => path.endsWith('/software-approvals') ? init?.method === 'POST' ? json({ id: requestId, ticketNumber: 'TKT-123' }, 201) : json({ items: [], canApprove: true }) : undefined)
    render(<AppsServicesPanel appsOnly systemView />)
    await selectDevice()
    fireEvent.change(screen.getByLabelText('Approved package'), { target: { value: applicationId } })
    fireEvent.click(await screen.findByRole('button', { name: 'Approve ticket' }))
    expect(screen.getByRole('button', { name: 'Confirm ticket approval' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Existing ticket number'), { target: { value: 'TKT-123' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm ticket approval' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mutations(fetchMock)).toHaveLength(1)
    expect(mutations(fetchMock)[0][0]).toBe(`/api/assets/${assetId}/software-approvals`)
    expect(JSON.parse(String(mutations(fetchMock)[0][1]?.body))).toEqual({ applicationId, ticketNumber: 'TKT-123', action: 'install', confirmed: true })
    expect(screen.getByRole('button', { name: 'Review install' })).toBeDisabled()
  })

  it('opens apps and services from system rows with assigned employee identity', async () => {
    const fetchMock = setup(path => path === '/api/devices' ? json([{ ...devices[0], assetId: 'ASSET-001', user: { email: 'employee@example.test' } }]) : undefined)
    render(<AppsServicesPanel appsOnly systemView />)
    expect(await screen.findByText('ASSET-001')).toBeVisible()
    expect(screen.getByText('employee@example.test')).toBeVisible()
    expect(screen.queryByRole('region', { name: 'Recorded applications' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apps for fixture-one' }))
    expect(await screen.findByRole('region', { name: 'Recorded applications' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Recorded services' })).toBeVisible()
    expect(screen.getByRole('region', { name: 'Live service controls' })).toBeVisible()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it.each(['/patch/apps', '/patch/apps-services'])('retires legacy apps route %s without requests', async pathname => {
    const fetchMock = setup()
    render(<PatchPage pathname={pathname} />)
    expect(screen.getByRole('heading', { name: 'Apps moved to Devices', level: 1 })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Open Devices' })).toHaveAttribute('href', '/devices')
    for (const name of ['Recorded applications', 'Live service controls', 'Recorded services', 'Patch metrics']) expect(screen.queryByRole('region', { name })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps unknown app outcomes recoverable in the apps-only view', async () => {
    const fetchMock = setup((path, init) => path.endsWith('/software-install') && init?.method === 'POST' ? Promise.reject(new TypeError('Connection lost')) : undefined)
    render(<AppsServicesPanel appsOnly />)
    await selectDevice(); await selectPackage(); await confirm()
    expect(await screen.findByText(/Outcome unknown. Request ID retained/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Review install' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: `Check status ${requestId}` }))
    expect(await screen.findByText(/No durable result found/)).toBeVisible()
    expect(mutations(fetchMock)).toHaveLength(1)
  })

  it('shows detected desktop apps without libraries or unapproved package actions', async () => {
    const fetchMock = setup(path => path.startsWith('/api/software/catalog?') ? json({ items: [application, { ...application, id: 'system-package', name: 'System library', packageName: 'libsystem' }], capabilities, page: 1, hasMore: false }) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice()
    const recorded = screen.getByRole('region', { name: 'Recorded applications' })
    expect(within(recorded).getByText('Recorded fixture app')).toBeVisible()
    expect(within(recorded).queryByText('libsystem')).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /System library/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Recorded fixture app/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review remove' })).toBeDisabled()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it('does not classify legacy package records from browser-like names', async () => {
    setup(path => path === `/api/devices/${assetId}` ? json({ ...detail, installedApps: [{ name: 'google-chrome-stable', source: 'dpkg' }, { name: 'fixture-package', source: 'dpkg' }] }) : undefined)
    render(<AppsServicesPanel />)
    await waitFor(() => expect(screen.getByLabelText('Device')).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Device'), { target: { value: assetId } })
    expect(await screen.findByText(/No classified desktop apps recorded/)).toBeVisible()
    expect(screen.queryByRole('option', { name: /Approved fixture app/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review install' })).toBeDisabled()
  })

  it.each(['dpkg_desktop', 'rpm_desktop'])('excludes known desktop components from %s inventory and package choices', async source => {
    const components = ['cnrdrvcups-ufr2-uk', 'eog', 'evince', 'gnome-calculator', 'gnome-characters', 'gnome-clocks', 'gnome-font-viewer', 'gnome-text-editor', 'info', 'nautilus', 'seahorse', 'vim-common', 'yelp', 'vim-common:amd64']
    const thirdParty = ['google-chrome-stable', 'onlyoffice-desktopeditors', 'netbird-ui', 'pritunl-client-electron', 'rustdesk', 'independent-editor']
    const installedApps = [...detail.installedApps, ...components.map(name => ({ name, source })), ...thirdParty.map(name => ({ name, source })), { name: 'firefox', source: 'snap_desktop' }]
    const fetchMock = setup(path => {
      if (path === `/api/devices/${assetId}`) return json({ ...detail, installedApps })
      if (path.startsWith('/api/software/catalog?')) return json({ items: [application, { ...application, id: 'component-approval', name: 'System file manager', packageName: 'nautilus' }], capabilities, page: 1, hasMore: false })
      return undefined
    })
    render(<AppsServicesPanel />)
    await selectDevice()
    const recorded = within(screen.getByRole('region', { name: 'Recorded applications' }))
    for (const name of components) expect(recorded.queryByText(name)).not.toBeInTheDocument()
    for (const name of [...thirdParty, 'firefox']) expect(recorded.getByText(name)).toBeVisible()
    expect(screen.queryByRole('option', { name: /System file manager/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review remove' })).toBeDisabled()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it('reviews saved service code and applies only its confirmed version once', async () => {
    const fetchMock = setupScripts()
    render(<AppsServicesPanel />)
    const dialog = await reviewSavedScript()
    expect(dialog).toHaveTextContent(savedScript.body)
    expect(dialog).toHaveTextContent(savedScript.hash)
    expect(within(dialog).getByRole('button', { name: 'Confirm action' })).toBeDisabled()
    expect(mutations(fetchMock)).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm action' }))
    expect(await screen.findByText('script_exited_zero')).toBeVisible()
    const posts = mutations(fetchMock)
    expect(posts).toHaveLength(1)
    expect(posts[0][0]).toBe(`/api/assets/${assetId}/script-runs`)
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ requestId, scriptId: applicationId, scriptHash: savedScript.hash, confirmed: true })
  })

  it('rejects a saved script edited between selection and review', async () => {
    const fetchMock = setupScripts(path => path.endsWith(`/installation-scripts/${applicationId}`) ? json({ ...savedScript, hash: 'b'.repeat(64) }) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice()
    fireEvent.change(await screen.findByLabelText('Installation script'), { target: { value: applicationId } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review installation script' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Review installation script' }))
    expect(await screen.findByText(/Script changed. Refresh/)).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it('reviews shared shell scripts without assigning a company', async () => {
    const shared = { ...savedScript, entityId: '' }
    const fetchMock = setupScripts(path => path.includes('/installation-scripts?')
      ? json({ items: [shared], page: 1, hasMore: false, capabilities: { canApply: true } })
      : path.endsWith(`/installation-scripts/${applicationId}`) ? json(shared) : undefined)
    render(<AppsServicesPanel />)
    const dialog = await reviewSavedScript()
    expect(dialog).toHaveTextContent(shared.body)
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it('retains an unknown script request and checks status without redispatching', async () => {
    const fetchMock = setupScripts((path, init) => path.endsWith('/script-runs') && init?.method === 'POST' ? Promise.reject(new TypeError('Connection lost')) : undefined)
    render(<AppsServicesPanel />)
    const dialog = await reviewSavedScript()
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm action' }))
    expect(await screen.findByText(/Outcome unknown. Request ID retained/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Review installation script' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Approved package'), { target: { value: applicationId } })
    expect(screen.getByRole('button', { name: 'Review install' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: `Check status ${requestId}` }))
    expect(await screen.findByText(/No durable result found/)).toBeVisible()
    expect(fetchMock.mock.calls.some(([path]) => String(path) === `/api/assets/${assetId}/script-runs?requestId=${requestId}`)).toBe(true)
    expect(mutations(fetchMock)).toHaveLength(1)
    expect(sessionStorage.getItem(journalKey(authUser.id, entityId, assetId))).toContain(savedScript.hash)
  })

  it('does not expose script execution to an IT-team account even with claimed capabilities', async () => {
    const fetchMock = setupScripts(path => path === '/api/auth/me' ? json(authUser) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice()
    fireEvent.change(await screen.findByLabelText('Installation script'), { target: { value: applicationId } })
    expect(screen.getByRole('button', { name: 'Review installation script' })).toBeDisabled()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it('puts command-free install/remove controls ahead of recorded inventory', async () => {
    const fetchMock = setup()
    render(<AppsServicesPanel />)
    expect(screen.getByRole('heading', { name: 'Install / Remove Apps' })).toBeVisible()
    expect(screen.queryByText(/Requires the coordinated Apps & Services backend/)).not.toBeInTheDocument()
    await selectDevice(); await selectPackage()
    const approved = screen.getByRole('region', { name: 'Approved applications' })
    const recorded = screen.getByRole('region', { name: 'Recorded applications' })
    expect(approved.compareDocumentPosition(recorded) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(approved).getByRole('button', { name: 'Review install' })).toBeEnabled()
    expect(within(approved).getByRole('button', { name: 'Review remove' })).toBeEnabled()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it('uses the supplied direct route on first render without loading execution-only APIs', async () => {
    window.history.replaceState({}, '', '/patch')
    const fetchMock = setup()
    render(<PatchPage pathname="/patch/apps-services" />)
    expect(screen.getByRole('heading', { name: 'Apps moved to Devices', level: 1 })).toBeVisible()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('loads only selected authorized inventory, coverage and null live states, with scoped catalog pagination', async () => {
    const fetchMock = setup(path => path.startsWith('/api/software/catalog?') ? json({ items: path.endsWith('page=1') ? [] : [application], page: path.endsWith('page=1') ? 1 : 2, hasMore: path.endsWith('page=1'), capabilities }) : undefined)
    render(<AppsServicesPanel />)
    await screen.findByRole('option', { name: /FIX-1/ })
    expect(fetchMock.mock.calls.some(([path]) => String(path).startsWith('/api/devices/'))).toBe(false)
    fireEvent.change(screen.getByLabelText('Device'), { target: { value: assetId } })
    expect(await screen.findByText('Recorded fixture app')).toBeVisible()
    expect(screen.getByText('Software collection: partial')).toBeVisible()
    expect(screen.getByText('Scope: system packages only')).toBeVisible()
    expect(screen.getByText(/Returned: 1.*Total: 2.*Yes \(1 omitted\)/)).toBeVisible()
    expect(screen.getByText('Services collection: failed')).toBeVisible()
    expect(await screen.findByRole('option', { name: /Running: Unknown · Enabled: Unknown/ })).toBeInTheDocument()
    expect(await screen.findByText(/No approved desktop apps match/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Next catalog page' }))
    await screen.findByRole('option', { name: /Approved fixture app/ })
    expect(fetchMock).toHaveBeenCalledWith(`/api/software/catalog?entityId=${entityId}&os=linux&active=true&page=2`, expect.objectContaining({ signal: expect.any(AbortSignal), headers: { Authorization: 'Bearer fixture-token' } }))
    expect(screen.getByRole('button', { name: 'Next catalog page' })).toBeDisabled()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it.each(['install', 'remove'])('requires cancellable explicit confirmation and sends exact %s payload once', async action => {
    const fetchMock = setup()
    render(<AppsServicesPanel />)
    await selectDevice(); await selectPackage()
    fireEvent.click(screen.getByRole('button', { name: `Review ${action}` }))
    const dialog = screen.getByRole('dialog', { name: 'Confirm endpoint action' })
    expect(dialog).toHaveTextContent('FIX-1'); expect(dialog).toHaveTextContent(assetId)
    expect(dialog).toHaveTextContent('fixture-package'); expect(dialog).toHaveTextContent(action)
    expect(mutations(fetchMock)).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByLabelText('Approved package')).toHaveValue(applicationId)
    expect(mutations(fetchMock)).toHaveLength(0)
    await confirm(action)
    expect(await screen.findByText('succeeded')).toBeVisible()
    const posts = mutations(fetchMock)
    expect(posts).toHaveLength(1)
    expect(posts[0][0]).toBe(`/api/assets/${assetId}/${action === 'install' ? 'software-install' : 'management-actions'}`)
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual(action === 'install' ? { applicationId, approvalId: requestId, requestId, confirmed: true } : { requestId, kind: 'software', action: 'remove', applicationId, approvalId: asset2, confirmed: true })
    expect(posts[0][1]?.headers).toEqual({ Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' })
  })

  it.each(['start', 'stop', 'restart', 'enable', 'disable'])('sends exact confirmed service %s, never a service delete', async action => {
    const fetchMock = setup()
    render(<AppsServicesPanel />)
    await selectDevice()
    await screen.findByRole('option', { name: /Running: Unknown/ })
    fireEvent.change(screen.getByLabelText('Live service'), { target: { value: 'fixture.service' } })
    fireEvent.change(screen.getByLabelText('Service action'), { target: { value: action } })
    fireEvent.click(screen.getByRole('button', { name: 'Review service action' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('fixture.service')
    expect(screen.getByRole('dialog')).toHaveTextContent(action)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm action' }))
    await screen.findByText('succeeded')
    expect(mutations(fetchMock)).toHaveLength(1)
    expect(JSON.parse(String(mutations(fetchMock)[0][1]?.body))).toEqual({ requestId, kind: 'service', action, serviceName: 'fixture.service', confirmed: true })
    expect(screen.queryByRole('option', { name: 'delete' })).not.toBeInTheDocument()
  })

  it.each(['network', 'accepted', 'invalid'])('persists %s unknown outcomes across remount and recovers by GET only', async failure => {
    let statusReads = 0
    const fetchMock = setup((path, init) => {
      if (init?.method === 'POST') {
        if (failure === 'network') return Promise.reject(new Error('Connection lost'))
        return json(failure === 'invalid' ? {} : { install: { requestId, assetId, applicationId, status: 'unknown', outcomeCode: 'response_unavailable', createdAt: '2026-09-21', updatedAt: '2026-09-21' } }, failure === 'accepted' ? 202 : 200)
      }
      if (path.includes(`software-installs?requestId=${requestId}`)) {
        statusReads++
        return json({ items: statusReads === 1 ? [] : [{ requestId, assetId, applicationId, status: 'succeeded', outcomeCode: 'verified', createdAt: '2026-09-21', updatedAt: '2026-09-21' }], capabilities })
      }
      return undefined
    })
    const first = render(<AppsServicesPanel />)
    await selectDevice(); await selectPackage(); await confirm()
    await screen.findByText('unknown')
    await waitFor(() => expect(screen.getByRole('button', { name: `Check status ${requestId}` })).toBeEnabled())
    expect(screen.getByLabelText('Approved package')).toHaveValue(applicationId)
    expect(screen.getByRole('button', { name: 'Review install' })).toBeDisabled()
    expect(sessionStorage.getItem(journalKey('actor-fixture', entityId, assetId))).toContain(requestId)
    first.unmount()
    render(<AppsServicesPanel />)
    await selectDevice()
    expect(screen.getByText('unknown')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: `Check status ${requestId}` }))
    await screen.findByText(/No durable result found/)
    expect(screen.getByText('unknown')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: `Check status ${requestId}` }))
    await screen.findByText('succeeded')
    expect(mutations(fetchMock)).toHaveLength(1)
    expect(crypto.randomUUID).toHaveBeenCalledTimes(1)
  })

  it('displays backend failed outcome on HTTP success and preserves inputs without retry', async () => {
    const fetchMock = setup((_path, init) => init?.method === 'POST' ? json({ install: { requestId, assetId, applicationId, status: 'failed', outcomeCode: 'provider_unavailable', createdAt: '2026-09-21', updatedAt: '2026-09-21' } }) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice(); await selectPackage(); await confirm()
    expect(await screen.findByText('failed')).toBeVisible()
    expect(screen.getByText('provider_unavailable')).toBeVisible()
    expect(screen.queryByText('succeeded')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Approved package')).toHaveValue(applicationId)
    expect(mutations(fetchMock)).toHaveLength(1)
  })

  it.each([403, 404, 503])('locks unavailable action API (%s), preserves selection, and never retries', async status => {
    const fetchMock = setup((_path, init) => init?.method === 'POST' ? json({ error: 'endpoint management unavailable' }, status) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice(); await selectPackage(); await confirm('remove')
    await screen.findByText('unknown')
    expect(screen.getByRole('button', { name: 'Review remove' })).toBeDisabled()
    expect(screen.getByLabelText('Approved package')).toHaveValue(applicationId)
    expect(mutations(fetchMock)).toHaveLength(1)
  })

  it.each(['read-only', 'permissions403', 'management404', 'services403'])('fails closed for %s capabilities', async scenario => {
    const fetchMock = setup(path => {
      if (path === '/api/software/permissions' && scenario === 'permissions403') return json({}, 403)
      if (path === '/api/software/permissions' && scenario === 'read-only') return json({ canInstall: false, canManageCatalog: false })
      if (path.endsWith('/management-actions') && scenario === 'management404') return json({}, 404)
      if (path.endsWith('/services') && scenario === 'services403') return json({}, 403)
      return undefined
    })
    render(<AppsServicesPanel />)
    await selectDevice()
    fireEvent.change(screen.getByLabelText('Approved package'), { target: { value: applicationId } })
    if (scenario !== 'services403') expect(screen.getByRole('button', { name: 'Review remove' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Review service action' })).toBeDisabled()
    if (scenario.startsWith('permissions') || scenario === 'read-only') expect(screen.getByRole('button', { name: 'Review install' })).toBeDisabled()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it.each(['employee', 'unknown'])('guards read access for %s before requesting inventory', async role => {
    const fetchMock = setup(path => path === '/api/auth/me' ? json({ id: 'actor-fixture', role }) : undefined)
    render(<AppsServicesPanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent('does not have inventory management read access')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('makes no requests signed out', () => {
    localStorage.clear()
    const fetchMock = setup()
    render(<AppsServicesPanel />)
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not dispatch when the durable request ID cannot be stored', async () => {
    const fetchMock = setup()
    render(<AppsServicesPanel />)
    await selectDevice(); await selectPackage()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
    await confirm()
    expect(await screen.findByText(/Request preparation failed; no action was sent/)).toBeVisible()
    expect(mutations(fetchMock)).toHaveLength(0)
    expect(screen.getByLabelText('Approved package')).toHaveValue(applicationId)
  })

  it('revokes a selected package when refreshed catalog approval is removed', async () => {
    let approved = true
    const fetchMock = setup(path => path.startsWith('/api/software/catalog?') ? json({ items: approved ? [application] : [], capabilities, page: 1, hasMore: false }) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice(); await selectPackage()
    approved = false
    fireEvent.click(screen.getByRole('button', { name: 'Refresh capabilities & live data' }))
    await screen.findByText(/No approved desktop apps match/)
    expect(screen.getByRole('button', { name: 'Review install' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Review remove' })).toBeDisabled()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it('fails closed on unknown OS and never offers cross-entity or inactive catalog entries', async () => {
    setup(path => {
      if (path === `/api/devices/${assetId}`) return json({ ...detail, osName: 'Unrecognized platform' })
      if (path.startsWith('/api/software/catalog?')) return json({ items: [application, { ...application, id: 'other', entityId: 'other-entity' }, { ...application, id: 'inactive', active: false }], capabilities, page: 1, hasMore: false })
      return undefined
    })
    render(<AppsServicesPanel />)
    await waitFor(() => expect(screen.getByLabelText('Device')).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Device'), { target: { value: assetId } })
    await screen.findByText(/Unsupported or unrecorded OS/)
    await screen.findByText(/No approved desktop apps match/)
    expect(within(screen.getByLabelText('Approved package')).getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Review install' })).toBeDisabled()
  })

  it.each(['device', 'account'])('aborts and ignores late mutation results on %s switch, retaining unknown only in original scope', async scope => {
    let finish!: (response: Response) => void
    let signal: AbortSignal | null | undefined
    const fetchMock = setup((path, init) => {
      if (path === '/api/auth/me') return json({ id: localStorage.getItem('itms_token') === 'next-account' ? 'actor-two' : 'actor-fixture', role: 'it_team' })
      if (init?.method === 'POST') { signal = init.signal; return new Promise(resolve => { finish = resolve }) }
      return undefined
    })
    render(<AppsServicesPanel />)
    await selectDevice(); await selectPackage(); await confirm()
    expect(screen.getByRole('button', { name: 'Review install' })).toBeDisabled()
    if (scope === 'device') await selectDevice(asset2)
    else {
      act(() => { localStorage.setItem('itms_token', 'next-account'); window.dispatchEvent(new StorageEvent('storage', { key: 'itms_token' })) })
      await selectDevice()
    }
    expect(signal?.aborted).toBe(true)
    await act(async () => finish(json({ install: { requestId, assetId, status: 'succeeded', outcomeCode: 'late-old-scope', createdAt: '2026-09-21', updatedAt: '2026-09-21' } })))
    expect(screen.queryByText('late-old-scope')).not.toBeInTheDocument()
    expect(screen.queryByText(`Request ID: ${requestId}`)).not.toBeInTheDocument()
    expect(mutations(fetchMock)).toHaveLength(1)
    expect(JSON.parse(sessionStorage.getItem(journalKey('actor-fixture', entityId, assetId))!)[0].status).toBe('unknown')
  })

  it('aborts stale inventory reads and closes confirmation on device changes', async () => {
    let finish!: (response: Response) => void
    let signal: AbortSignal | null | undefined
    let firstRead = true
    setup((path, init) => {
      if (path === `/api/devices/${assetId}` && firstRead) { firstRead = false; signal = init?.signal; return new Promise(resolve => { finish = resolve }) }
      return undefined
    })
    render(<AppsServicesPanel />)
    await waitFor(() => expect(screen.getByLabelText('Device')).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Device'), { target: { value: assetId } })
    await selectDevice(asset2)
    expect(signal?.aborted).toBe(true)
    await act(async () => finish(json(detail)))
    expect(screen.getByText('Second inventory')).toBeVisible()
    expect(screen.queryByText('Recorded fixture app')).not.toBeInTheDocument()
    await selectPackage()
    fireEvent.click(screen.getByRole('button', { name: 'Review install' }))
    await selectDevice(assetId)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Approved package')).toHaveValue('')
  })

  it('locks synchronously during a pending mutation and performs no automatic status polls', async () => {
    let finish!: (response: Response) => void
    const fetchMock = setup((_path, init) => init?.method === 'POST' ? new Promise(resolve => { finish = resolve }) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice(); await selectPackage()
    fireEvent.click(screen.getByRole('button', { name: 'Review install' }))
    const button = screen.getByRole('button', { name: 'Confirm action' })
    fireEvent.click(button); fireEvent.click(button)
    expect(mutations(fetchMock)).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Refresh stored inventory' })).toBeDisabled()
    expect(fetchMock.mock.calls.filter(([path]) => String(path).includes('?requestId='))).toHaveLength(0)
    await act(async () => finish(json({ install: { requestId, assetId, applicationId, status: 'unknown', outcomeCode: 'unconfirmed', createdAt: '2026-09-21', updatedAt: '2026-09-21' } }, 202)))
    expect(screen.getByRole('button', { name: 'Review install' })).toBeDisabled()
  })

  it('uses explicit tab mapping, preserves existing tabs and follows back/forward', async () => {
    window.history.replaceState({}, '', '/patch/ssh')
    setup()
    render(<PatchPage />)
    expect(screen.getByRole('tab', { name: 'SSH' })).toHaveAttribute('aria-selected', 'true')
    for (const name of ['Salt', 'SSH', 'Automation', 'Report']) expect(screen.getByRole('tab', { name })).toBeVisible()
    expect(screen.queryByRole('tab', { name: 'Apps & Services' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Report' }))
    expect(window.location.pathname).toBe('/patch/reports')
    act(() => window.history.back())
    await waitFor(() => expect(screen.getByRole('tab', { name: 'SSH' })).toHaveAttribute('aria-selected', 'true'))
    act(() => window.history.forward())
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Report' })).toHaveAttribute('aria-selected', 'true'))
  })

  it('uses history unknown records to prevent duplicate actions even without a local journal', async () => {
    const record: ActionRecord = { requestId, assetId, applicationId, kind: 'software', action: 'remove', status: 'unknown', outcomeCode: 'response_unavailable', createdAt: '2026-09-21', updatedAt: '2026-09-21' }
    const fetchMock = setup(path => path.endsWith('/management-actions') ? json({ items: [record], capabilities }) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice()
    fireEvent.change(screen.getByLabelText('Approved package'), { target: { value: applicationId } })
    expect(await screen.findByText('unknown')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Review remove' })).toBeDisabled()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it.each([undefined, {}])('prevents endpoint writes and journal reservations without a CSPRNG (%s)', async source => {
    const fetchMock = setup()
    render(<AppsServicesPanel />)
    await selectDevice(); await selectPackage()
    vi.stubGlobal('crypto', source)
    await confirm()
    expect(await screen.findByText(/Request preparation failed; no action was sent/)).toBeVisible()
    expect(mutations(fetchMock)).toHaveLength(0)
    expect(sessionStorage.getItem(journalKey(authUser.id, entityId, assetId))).toBeNull()
  })

  it('uses the secure fallback for endpoint writes on HTTP without randomUUID', async () => {
    const fetchMock = setup()
    render(<AppsServicesPanel />)
    await selectDevice(); await selectPackage()
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(255) })
    await confirm()
    await screen.findByText('succeeded')
    expect(JSON.parse(String(mutations(fetchMock)[0][1]?.body))).toEqual({ applicationId, approvalId: requestId, requestId: 'ffffffff-ffff-4fff-bfff-ffffffffffff', confirmed: true })
  })

  it('reports explicit false truncation as No, while absent coverage remains Not reported', async () => {
    setup(path => path === `/api/devices/${assetId}` ? json({ ...detail, collectionStatus: { software: { truncated: false, truncated_count: 0 }, services: {} } }) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice()
    expect(within(screen.getByRole('region', { name: 'Recorded applications' })).getByText(/Truncation: No$/)).toBeVisible()
    expect(within(screen.getByRole('region', { name: 'Recorded services' })).getByText(/Truncation: Not reported$/)).toBeVisible()
  })

  it.each(['admin', 'it_team', 'auditor'])('hides catalog creation for %s even with a claimed capability', async role => {
    const fetchMock = setupCatalog(path => path === '/api/auth/me' ? json({ ...authUser, role }) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice()
    expect(screen.queryByRole('button', { name: 'Add approved application' })).not.toBeInTheDocument()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it.each(['false', 'missing', 'forbidden'])('requires affirmative server catalog capability (%s)', async scenario => {
    const fetchMock = setupCatalog(path => path === '/api/software/permissions' ? json(scenario === 'false' ? capabilities : {}, scenario === 'forbidden' ? 403 : 200) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice()
    expect(screen.queryByRole('button', { name: 'Add approved application' })).not.toBeInTheDocument()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it.each([{ role: 'super_admin' }, { user: { id: 'actor-fixture', role: 'super_admin' } }])('fails closed without the real flat auth identity (%j)', async payload => {
    const fetchMock = setupCatalog(path => path === '/api/auth/me' ? json(payload) : undefined)
    render(<AppsServicesPanel />)
    await screen.findByRole('alert')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Add approved application' })).not.toBeInTheDocument()
  })

  it.each(['', 'Trusted source verified'])('creates the exact asset-scoped payload with optional description (%s)', async description => {
    const fetchMock = setupCatalog()
    render(<AppsServicesPanel />)
    await openCatalogForm()
    const dialog = screen.getByRole('dialog', { name: 'Add approved application' })
    expect(dialog).toHaveTextContent(`Entity: ${entityId} · OS: linux (locked to this asset)`)
    expect(dialog).toHaveTextContent('entire entity and OS, not just this asset')
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(3)
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument()
    fillCatalogForm(description)
    fireEvent.click(screen.getByRole('button', { name: 'Approve and add' }))
    await screen.findByText(/Approved application added/)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mutations(fetchMock)).toHaveLength(1)
    const [url, init] = mutations(fetchMock)[0]
    expect(url).toBe('/api/software/catalog')
    expect(JSON.parse(String(init?.body))).toEqual({ entityId, name: 'New approved application', os: 'linux', packageName: 'Vendor.App_1+2-3', active: true, ...(description ? { description } : {}) })
    expect(init?.headers).toEqual({ Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' })
    expect(crypto.randomUUID).not.toHaveBeenCalled()
    await screen.findByRole('option', { name: /Approved fixture app/ })
    expect(fetchMock.mock.calls.filter(([path]) => String(path).startsWith('/api/software/catalog?'))).toHaveLength(2)
    expect(screen.getByLabelText('Approved package')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Review install' })).toBeDisabled()
    expect(screen.queryByRole('option', { name: /New approved application/ })).not.toBeInTheDocument()
  })

  it('validates names, exact identifiers and explicit approval without losing form values or dispatching', async () => {
    const fetchMock = setupCatalog()
    render(<AppsServicesPanel />)
    await openCatalogForm()
    fillCatalogForm('Keep this description')
    const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Approve and add' }))
    for (const name of [' ', 'x'.repeat(151)]) {
      fireEvent.change(screen.getByLabelText('Application name'), { target: { value: name } }); submit()
      expect(await screen.findByText(/Application name is required/)).toBeVisible()
      expect(screen.getByLabelText('Application name')).toHaveValue(name)
    }
    fireEvent.change(screen.getByLabelText('Application name'), { target: { value: 'Valid name' } })
    expect(screen.getByLabelText('Application name')).toHaveAttribute('maxlength', '150')
    for (const identifier of ['-flag', 'pkg;cmd', 'pkg name', 'pkg/path', 'a'.repeat(201)]) {
      fireEvent.change(screen.getByLabelText('Package identifier'), { target: { value: identifier } }); submit()
      expect(await screen.findByText(/Package identifier must/)).toBeVisible()
      expect(screen.getByLabelText('Package identifier')).toHaveValue(identifier)
    }
    fireEvent.change(screen.getByLabelText('Package identifier'), { target: { value: 'valid.pkg' } })
    fireEvent.click(screen.getByLabelText('I approve this exact package for this entity and OS.')); submit()
    expect(await screen.findByText('Explicit package approval is required.')).toBeVisible()
    expect(screen.getByLabelText('Description (optional)')).toHaveValue('Keep this description')
    expect(mutations(fetchMock)).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add approved application' }))
    expect(screen.getByLabelText('Application name')).toHaveValue('Valid name')
  })

  it.each(['rejected', 'network', 'server', 'invalid-response'])('preserves failed catalog inputs without automatic retry (%s)', async failure => {
    const fetchMock = setupCatalog((path, init) => {
      if (path === '/api/software/catalog' && init?.method === 'POST') {
        if (failure === 'network') return Promise.reject(new Error('Connection lost'))
        return json(failure === 'invalid-response' ? {} : { error: 'Catalog write failed' }, failure === 'rejected' ? 409 : failure === 'server' ? 500 : 200)
      }
      return undefined
    })
    render(<AppsServicesPanel />)
    await openCatalogForm(); fillCatalogForm('Keep me')
    fireEvent.click(screen.getByRole('button', { name: 'Approve and add' }))
    expect(await screen.findByText(/No automatic retry was made/)).toBeVisible()
    expect(screen.getByLabelText('Application name')).toHaveValue('New approved application')
    expect(screen.getByLabelText('Package identifier')).toHaveValue('Vendor.App_1+2-3')
    expect(screen.getByLabelText('Description (optional)')).toHaveValue('Keep me')
    expect(screen.getByLabelText('I approve this exact package for this entity and OS.')).toBeChecked()
    if (failure !== 'rejected') {
      expect(screen.getByText(/Refresh catalog and check for the entry/)).toBeVisible()
      expect(screen.getByRole('button', { name: 'Approve and add' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Refresh catalog before retry' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Approve and add' })).toBeEnabled())
    }
    expect(mutations(fetchMock)).toHaveLength(1)
  })

  it('locks duplicate catalog submissions synchronously and refreshes only catalog, retaining the action journal', async () => {
    let finish!: (response: Response) => void
    const record: ActionRecord = { requestId, assetId, applicationId, kind: 'software', action: 'install', status: 'unknown', outcomeCode: 'response_unavailable', createdAt: '2026-09-21', updatedAt: '2026-09-21' }
    sessionStorage.setItem(journalKey(authUser.id, entityId, assetId), JSON.stringify([record]))
    const fetchMock = setupCatalog((path, init) => path === '/api/software/catalog' && init?.method === 'POST' ? new Promise(resolve => { finish = resolve }) : undefined)
    render(<AppsServicesPanel />)
    await openCatalogForm(); fillCatalogForm()
    const history = screen.getByRole('region', { name: 'Action history' })
    const requestsBefore = fetchMock.mock.calls.length
    const submit = screen.getByRole('button', { name: 'Approve and add' })
    act(() => { fireEvent.submit(submit.closest('form')!); fireEvent.submit(submit.closest('form')!) })
    expect(mutations(fetchMock)).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled()
    expect(screen.getByLabelText('Application name')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(screen.getByRole('dialog')).toBeVisible()
    await act(async () => finish(json({ ...application, id: 'new-application', packageName: 'Vendor.App_1+2-3' }, 201)))
    await screen.findByText(/Approved application added/)
    await screen.findByRole('option', { name: /Approved fixture app/ })
    expect(screen.getByRole('region', { name: 'Action history' })).toBe(history)
    expect(within(history).getByText('unknown')).toBeVisible()
    expect(fetchMock.mock.calls.slice(requestsBefore).map(([path]) => path)).toEqual(['/api/software/catalog', `/api/software/catalog?entityId=${entityId}&os=linux&active=true&page=1`])
    expect(JSON.parse(sessionStorage.getItem(journalKey(authUser.id, entityId, assetId))!)).toEqual([record])
  })

  it.each(['device', 'account'])('aborts catalog creation and hides the old form on %s switch', async scope => {
    let finish!: (response: Response) => void
    let signal: AbortSignal | null | undefined
    const fetchMock = setupCatalog((path, init) => {
      if (path === '/api/software/catalog' && init?.method === 'POST') { signal = init.signal; return new Promise(resolve => { finish = resolve }) }
      return undefined
    })
    render(<AppsServicesPanel />)
    await openCatalogForm(); fillCatalogForm('Old scope draft')
    fireEvent.click(screen.getByRole('button', { name: 'Approve and add' }))
    if (scope === 'device') await selectDevice(asset2)
    else {
      act(() => { localStorage.setItem('itms_token', 'next-account'); window.dispatchEvent(new StorageEvent('storage', { key: 'itms_token' })) })
      await selectDevice()
    }
    expect(signal?.aborted).toBe(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await act(async () => finish(json({ ...application, id: 'new-application', packageName: 'Vendor.App_1+2-3' }, 201)))
    expect(screen.queryByText(/Approved application added/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add approved application' }))
    expect(screen.getByLabelText('Application name')).toHaveValue('')
    expect(screen.getByLabelText('Description (optional)')).toHaveValue('')
    expect(mutations(fetchMock)).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([path]) => String(path).startsWith('/api/software/catalog?'))).toHaveLength(2)
  })

  it('uses the newly selected asset entity and OS, never the account entity or previous draft', async () => {
    const nextEntity = '66666666-6666-4666-8666-666666666666'
    const fetchMock = setupCatalog(path => path === `/api/devices/${asset2}` ? json({ ...detail, id: asset2, entityId: nextEntity, osName: 'Microsoft Windows 11', assetTag: 'FIX-2' }) : undefined)
    render(<AppsServicesPanel />)
    await openCatalogForm(); fillCatalogForm('Previous asset')
    fireEvent.change(screen.getByLabelText('Device'), { target: { value: asset2 } })
    await screen.findByText(/OS: Microsoft Windows 11/)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Add approved application' }))
    expect(screen.getByLabelText('Application name')).toHaveValue('')
    expect(screen.getByRole('dialog')).toHaveTextContent(`Entity: ${nextEntity} · OS: windows (locked to this asset)`)
    fillCatalogForm()
    fireEvent.click(screen.getByRole('button', { name: 'Approve and add' }))
    await screen.findByText(/Approved application added/)
    expect(mutations(fetchMock)).toHaveLength(1)
    expect(JSON.parse(String(mutations(fetchMock)[0][1]?.body))).toEqual({ entityId: nextEntity, name: 'New approved application', os: 'windows', packageName: 'Vendor.App_1+2-3', active: true })
  })

  it('does not offer creation for an unknown asset OS even to a capable super admin', async () => {
    const fetchMock = setupCatalog(path => path === `/api/devices/${assetId}` ? json({ ...detail, osName: 'Unknown appliance' }) : undefined)
    render(<AppsServicesPanel />)
    await waitFor(() => expect(screen.getByLabelText('Device')).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Device'), { target: { value: assetId } })
    await screen.findByText(/Unsupported or unrecorded OS/)
    expect(screen.queryByRole('button', { name: 'Add approved application' })).not.toBeInTheDocument()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it('keeps ambiguous creation locked through a failed refresh and permits another read, never an automatic write', async () => {
    let catalogReads = 0
    const fetchMock = setupCatalog((path, init) => {
      if (path === '/api/software/catalog' && init?.method === 'POST') return Promise.reject(new Error('Connection lost'))
      if (path.startsWith('/api/software/catalog?') && ++catalogReads === 2) return json({ error: 'Refresh unavailable' }, 500)
      return undefined
    })
    render(<AppsServicesPanel />)
    await openCatalogForm(); fillCatalogForm()
    fireEvent.click(screen.getByRole('button', { name: 'Approve and add' }))
    await screen.findByText(/Outcome uncertain/)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh catalog before retry' }))
    await screen.findByText('Catalog unavailable: Refresh unavailable')
    expect(screen.getByRole('button', { name: 'Approve and add' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refresh catalog before retry' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh catalog before retry' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve and add' })).toBeEnabled())
    expect(mutations(fetchMock)).toHaveLength(1)
    expect(catalogReads).toBe(3)
  })

  it('refreshes creation success from page one without assuming the returned application is an option', async () => {
    const fetchMock = setupCatalog(path => path.startsWith('/api/software/catalog?') ? json({ items: [application], capabilities, page: path.endsWith('page=2') ? 2 : 1, hasMore: path.endsWith('page=1') }) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice()
    fireEvent.click(screen.getByRole('button', { name: 'Next catalog page' }))
    await screen.findByRole('option', { name: /Approved fixture app/ })
    expect(screen.getByText('Page 2')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Add approved application' }))
    fillCatalogForm()
    fireEvent.click(screen.getByRole('button', { name: 'Approve and add' }))
    await screen.findByText(/the new entry may be on a later page/)
    await screen.findByRole('option', { name: /Approved fixture app/ })
    expect(screen.getByText('Page 1')).toBeVisible()
    expect(screen.getByLabelText('Approved package')).toHaveValue('')
    expect(screen.queryByRole('option', { name: /New approved application/ })).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.filter(([path]) => String(path).startsWith('/api/software/catalog?')).map(([path]) => path)).toEqual([1, 2, 1].map(page => `/api/software/catalog?entityId=${entityId}&os=linux&active=true&page=${page}`))
    expect(mutations(fetchMock)).toHaveLength(1)
  })

  it.each(['admin', 'auditor'])('uses the inventory directory for %s readers without execution API calls', async role => {
    const fetchMock = setup(path => path === '/api/auth/me' ? json({ ...authUser, role }) : undefined)
    render(<AppsServicesPanel appsOnly systemView />)
    await selectDevice()
    fireEvent.change(screen.getByLabelText('Approved package'), { target: { value: applicationId } })
    expect(screen.getByRole('region', { name: 'Live service controls' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Start service fixture.service' })).toBeDisabled()
    expect(screen.getByText(/Read-only access/)).toBeVisible()
    for (const name of ['Review install', 'Review remove']) expect(screen.getByRole('button', { name })).toBeDisabled()
    expect(fetchMock.mock.calls.some(([path]) => String(path).startsWith('/api/patch/'))).toBe(false)
    expect(screen.queryByRole('region', { name: 'Patch metrics' })).not.toBeInTheDocument()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it.each(['software-installs', 'management-actions'])('waits for %s before allowing any endpoint mutation', async endpoint => {
    let finish!: (response: Response) => void
    const fetchMock = setup(path => path.endsWith(`/${endpoint}`) ? new Promise(resolve => { finish = resolve }) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice()
    fireEvent.change(screen.getByLabelText('Approved package'), { target: { value: applicationId } })
    fireEvent.change(screen.getByLabelText('Live service'), { target: { value: 'fixture.service' } })
    expect(screen.getByText('Checking device capabilities and action history…')).toBeVisible()
    for (const name of ['Review install', 'Review remove', 'Review service action']) expect(screen.getByRole('button', { name })).toBeDisabled()
    await act(async () => finish(json({ items: [{ requestId, assetId, applicationId, kind: 'software', action: 'remove', status: 'unknown', outcomeCode: 'dispatch_unconfirmed', createdAt: '2026-09-21', updatedAt: '2026-09-21' }], capabilities })))
    expect(screen.getByText('unknown')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Review install' })).toBeDisabled()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it.each(['software-installs', 'management-actions', 'services', 'catalog'])('fails closed on malformed %s resource responses', async endpoint => {
    const fetchMock = setup(path => (endpoint === 'catalog' ? path.startsWith('/api/software/catalog?') : path.endsWith(`/${endpoint}`)) ? json({ items: null }) : undefined)
    render(<AppsServicesPanel />)
    await waitFor(() => expect(screen.getByLabelText('Device')).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Device'), { target: { value: assetId } })
    await screen.findByText(/Invalid API response/)
    expect(screen.getByRole('button', { name: 'Review service action' })).toBeDisabled()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it.each([400, 401, 403, 404, 409, 500, 503])('does not invent failed endpoint outcomes from HTTP %s', async status => {
    const fetchMock = setup((_path, init) => init?.method === 'POST' ? json({ error: 'Request rejected' }, status) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice(); await selectPackage(); await confirm()
    await screen.findByText(/Outcome unknown. Request ID retained/)
    expect(screen.getByText('unknown')).toBeVisible()
    expect(screen.queryByText('failed')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review install' })).toBeDisabled()
    expect(mutations(fetchMock)).toHaveLength(1)
    expect(mutations(fetchMock)[0][1]?.redirect).toBe('error')
  })

  it.each(['mismatched-application', 'persistence-unconfirmed'])('retains unknown for %s mutation results', async scenario => {
    const fetchMock = setup((_path, init) => init?.method === 'POST' ? json({ install: { requestId, assetId, applicationId: scenario === 'mismatched-application' ? asset2 : applicationId, status: 'succeeded', outcomeCode: 'verified', createdAt: '2026-09-21', updatedAt: '2026-09-21' }, outcomePersistenceUnconfirmed: scenario === 'persistence-unconfirmed' }) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice(); await selectPackage(); await confirm()
    await screen.findByText(/Outcome unknown. Request ID retained/)
    expect(screen.getByText('unknown')).toBeVisible()
    expect(screen.queryByText('succeeded')).not.toBeInTheDocument()
    expect(mutations(fetchMock)).toHaveLength(1)
  })

  it('uses each newly selected device capability, not the previous device permission', async () => {
    const fetchMock = setup(path => path.startsWith(`/api/assets/${asset2}/`) ? json({ items: [], status: 'success', capabilities: { canInstall: false, canManage: false } }) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice(); await selectPackage()
    fireEvent.click(screen.getByRole('button', { name: 'Review install' }))
    await selectDevice(asset2)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Approved package'), { target: { value: applicationId } })
    for (const name of ['Review install', 'Review remove', 'Review service action']) expect(screen.getByRole('button', { name })).toBeDisabled()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it('refreshes terminal history over a local unknown reservation without a second POST', async () => {
    const unknown: ActionRecord = { requestId, assetId, applicationId, kind: 'software', action: 'install', status: 'unknown', outcomeCode: 'response_unavailable', createdAt: '2099-01-01', updatedAt: '2099-01-01' }
    sessionStorage.setItem(journalKey(authUser.id, entityId, assetId), JSON.stringify([unknown]))
    const fetchMock = setup(path => path.endsWith('/software-installs') ? json({ items: [{ ...unknown, status: 'succeeded', outcomeCode: 'package_changed', updatedAt: '2026-09-21' }], capabilities }) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice(); await selectPackage()
    expect(screen.getByText('succeeded')).toBeVisible()
    expect(screen.queryByText('unknown')).not.toBeInTheDocument()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it('contains dialog focus, supports Escape and restores focus to review', async () => {
    const fetchMock = setup()
    render(<AppsServicesPanel />)
    await selectDevice(); await selectPackage()
    const review = screen.getByRole('button', { name: 'Review remove' })
    review.focus(); fireEvent.click(review)
    const close = screen.getByRole('button', { name: 'Close dialog' })
    const submit = screen.getByRole('button', { name: 'Confirm action' })
    expect(close).toHaveFocus()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(submit).toHaveFocus()
    fireEvent.keyDown(submit, { key: 'Tab' })
    expect(close).toHaveFocus()
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(review).toHaveFocus()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it('aborts app reads when navigation leaves the page', async () => {
    let signal: AbortSignal | null | undefined
    let finish!: (response: Response) => void
    setup((path, init) => path.startsWith('/api/software/catalog?') ? (signal = init?.signal, new Promise(resolve => { finish = resolve })) : undefined)
    const mounted = render(<DeviceOverviewPage assetId={assetId} pathname={`/devices/${assetId}/apps`} />)
    await waitFor(() => expect(signal).toBeDefined())
    mounted.rerender(<DeviceOverviewPage assetId={assetId} pathname={`/devices/${assetId}/system`} />)
    expect(signal?.aborted).toBe(true)
    mounted.unmount()
    await act(async () => finish(json({ items: [application], capabilities, page: 1, hasMore: false })))
    expect(screen.queryByRole('region', { name: 'Apps & Services' })).not.toBeInTheDocument()
  })

  it.each(['/auth/me', '/devices', `/devices/${assetId}`])('shows initial %s errors without inventing inventory or attempting writes', async endpoint => {
    const fetchMock = setup(path => path === `/api${endpoint}` ? json({ error: 'Initial read unavailable' }, 500) : undefined)
    render(<AppsServicesPanel />)
    if (endpoint === `/devices/${assetId}`) {
      await waitFor(() => expect(screen.getByLabelText('Device')).toBeEnabled())
      fireEvent.change(screen.getByLabelText('Device'), { target: { value: assetId } })
    }
    expect(await screen.findByRole('alert')).toHaveTextContent('Initial read unavailable')
    expect(screen.queryByText('Recorded fixture app')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review install' })).not.toBeInTheDocument()
    expect(mutations(fetchMock)).toHaveLength(0)
  })

  it('ignores late status recovery after switching devices and retains the original reservation', async () => {
    const record: ActionRecord = { requestId, assetId, applicationId, kind: 'software', action: 'install', status: 'unknown', outcomeCode: 'response_unavailable', createdAt: '2026-09-21', updatedAt: '2026-09-21' }
    sessionStorage.setItem(journalKey(authUser.id, entityId, assetId), JSON.stringify([record]))
    let signal: AbortSignal | null | undefined
    let finish!: (response: Response) => void
    const fetchMock = setup((path, init) => path.includes(`?requestId=${requestId}`) ? (signal = init?.signal, new Promise(resolve => { finish = resolve })) : undefined)
    render(<AppsServicesPanel />)
    await selectDevice()
    fireEvent.click(screen.getByRole('button', { name: `Check status ${requestId}` }))
    await selectDevice(asset2)
    expect(signal?.aborted).toBe(true)
    await act(async () => finish(json({ items: [{ ...record, status: 'succeeded', outcomeCode: 'late-status' }], capabilities })))
    expect(screen.queryByText('late-status')).not.toBeInTheDocument()
    expect(screen.queryByText('succeeded')).not.toBeInTheDocument()
    expect(JSON.parse(sessionStorage.getItem(journalKey(authUser.id, entityId, assetId))!)[0].status).toBe('unknown')
    expect(mutations(fetchMock)).toHaveLength(0)
  })
})