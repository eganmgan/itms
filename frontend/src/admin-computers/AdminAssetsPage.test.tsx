import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminAssetsPage } from './AdminAssetsPage'
import type { Computer } from './api'
import { computer, deferred, ids, json, options } from './fixtures.test-support'
import { fields } from './model'

const change = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const writes = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST' || init?.method === 'PATCH')
let current: Computer
let fail: string
function mockAPI(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  if (url.includes('/options')) {
    if (fail === 'options') return Promise.resolve(json({ error: 'Options unavailable' }, 500))
    return Promise.resolve(json(url.includes(ids.other) ? { ...options, entities: [options.entities[1]], locations: [], departments: [], users: [], technicians: [] } : options))
  }
  if (init?.method === 'POST' || init?.method === 'PATCH') {
    if (fail === 'write') return Promise.resolve(json({ error: 'Duplicate asset number' }, 409))
    current = { ...current, ...JSON.parse(String(init.body)) }
    return Promise.resolve(json(current, init.method === 'POST' ? 201 : 200))
  }
  if (url.includes(`/assets/${ids.asset}`)) return Promise.resolve(fail === 'detail' ? json({ error: 'computer not found' }, 404) : json(current))
  if (fail === 'list') return Promise.resolve(json({ error: 'Computer operation failed' }, 500))
  const page = Number(new URL(url, 'http://fixture.test').searchParams.get('page') || 1)
  const pageSize = Number(new URL(url, 'http://fixture.test').searchParams.get('pageSize') || 25)
  return Promise.resolve(json({ items: [{ ...current, name: page === 1 ? current.name : 'Second page computer' }], total: 26, page, pageSize }))
}
async function mount() {
  const onDenied = vi.fn()
  const view = render(<AdminAssetsPage token="fixture-token" onDenied={onDenied} />)
  await screen.findByRole('button', { name: `Details for ${computer.assetTag}` })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create computer' })).toBeEnabled())
  return { ...view, onDenied }
}
async function createForm() {
  await mount()
  fireEvent.click(screen.getByRole('button', { name: 'Create computer' }))
  change(/^Entity \*/, ids.entity)
  await waitFor(() => expect(screen.getByLabelText('Location')).toBeEnabled())
}
async function editForm() {
  await mount()
  fireEvent.click(screen.getByRole('button', { name: `Details for ${computer.assetTag}` }))
  await screen.findByRole('button', { name: 'Edit computer' })
  fireEvent.click(screen.getByRole('button', { name: 'Edit computer' }))
  await waitFor(() => expect(screen.getByLabelText('Location')).toBeEnabled())
}

describe('manual computer page', () => {
  beforeEach(() => { current = { ...computer }; fail = ''; localStorage.setItem('itms_token', 'fixture-token'); vi.stubGlobal('fetch', vi.fn(mockAPI)) })
  afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('creates with all exact contract fields and no stock endpoint', async () => {
    await createForm()
    for (const field of fields.filter(field => field.key !== 'entityId')) change(new RegExp(`^${field.label.replace(/[()]/g, '\\$&')}( \\*)?$`), String(computer[field.key] ?? ''))
    expect(screen.getByLabelText('Warranty expiry')).toHaveTextContent('2024-02-29')
    fireEvent.click(screen.getByRole('button', { name: 'Save computer' }))
    await screen.findByRole('button', { name: 'Edit computer' })
    expect(writes()).toHaveLength(1)
    const { id: _id, isCompute: _compute, warrantyUntil: _until, ...expected } = computer
    expect(writes()[0][0]).toBe('/api/admin/assets')
    expect(JSON.parse(String(writes()[0][1]?.body))).toEqual(expected)
    expect(writes()[0][1]).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' } })
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).startsWith('/api/admin/assets'))).toBe(true)
  })

  it('loads details, renders names and exact cost, and edits sparse values with explicit null', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Details for PC-001' }))
    await screen.findByText('Assigned person')
    expect(screen.getByText('1234567890.12')).toBeVisible()
    expect(screen.getByText('2024-02-29')).toBeVisible()
    expect(screen.getAllByText('IT department')).toHaveLength(2)
    for (const name of ['Financial & Administrative Information', 'Management Asset Lifecycle', 'Warranty Information']) expect(screen.getByRole('heading', { name })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Edit computer' }))
    await waitFor(() => expect(screen.getByLabelText('User')).toBeEnabled())
    change('Name *', 'Renamed computer'); change('Cost', ''); change('User', ''); change('OS name', '')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByRole('button', { name: 'Edit computer' })
    expect(writes()).toHaveLength(1)
    expect(writes()[0][0]).toBe(`/api/admin/assets/${ids.asset}`)
    expect(writes()[0][1]?.method).toBe('PATCH')
    expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({ name: 'Renamed computer', cost: null, assignedUserId: null, osName: null })
  })

  it('loads canonical supplier contact details on demand without changing asset fields', async () => {
    await editForm()
    vi.mocked(fetch).mockImplementation((url, init) => String(url).endsWith(`/admin/suppliers/${ids.supplier}`) ? Promise.resolve(json({ id: ids.supplier, name: 'Global supplier', contactInfo: 'Purchasing contact' })) : mockAPI(url, init))
    fireEvent.click(screen.getByRole('button', { name: 'View supplier details' }))
    expect(await screen.findByText('Purchasing contact')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Supplier directory & administration' })).toHaveAttribute('href', '/admin/suppliers')
    expect(writes()).toHaveLength(0)
    change('Supplier', '')
    expect(screen.queryByText('Purchasing contact')).not.toBeInTheDocument()
  })

  it('clears incompatible entity relationships and reloads scoped ID options, preserving supplier', async () => {
    await editForm()
    change('Entity *', ids.other)
    expect(screen.getByLabelText('Location')).toBeDisabled()
    await waitFor(() => expect(screen.getByLabelText('Location')).toBeEnabled())
    for (const label of ['Location', 'Department', 'Group in charge', 'User', 'Technician in charge']) expect(screen.getByLabelText(label)).toHaveValue('')
    expect(screen.getByLabelText('Supplier')).toHaveValue(ids.supplier)
    expect(within(screen.getByLabelText('Location')).queryByText('HQ')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({ entityId: ids.other, locationId: null, deptId: null, groupInChargeId: null, assignedUserId: null, technicianInChargeId: null })
  })

  it('blocks double submit while saving and never automatically retries writes', async () => {
    await editForm()
    const pending = deferred<Response>()
    vi.mocked(fetch).mockImplementation((url, init) => init?.method === 'PATCH' ? pending.promise : mockAPI(url, init))
    change('Name *', 'One write')
    const form = screen.getByRole('form', { name: 'Edit computer' })
    fireEvent.submit(form); fireEvent.submit(form)
    expect(writes()).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled()
    await act(async () => pending.resolve(json({ ...computer, name: 'One write' })))
    await screen.findByRole('button', { name: 'Edit computer' })
    expect(writes()).toHaveLength(1)
  })

  it('validates form inputs and preserves dirty values on write conflict', async () => {
    await createForm()
    fireEvent.click(screen.getByRole('button', { name: 'Save computer' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required')
    expect(screen.getByRole('alert')).not.toHaveTextContent('No automatic write retry')
    change('Name *', 'Unsaved'); change('Asset number *', 'NEW-PC'); change('Type *', 'laptop'); change('Cost', '1e5')
    fireEvent.click(screen.getByRole('button', { name: 'Save computer' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Cost must be')
    expect(writes()).toHaveLength(0)
    change('Cost', '0.00'); fail = 'write'
    fireEvent.click(screen.getByRole('button', { name: 'Save computer' }))
    await screen.findByText(/Duplicate asset number/)
    expect(screen.getByLabelText('Name *')).toHaveValue('Unsaved')
    expect(screen.getByLabelText('Cost')).toHaveValue('0.00')
    expect(writes()).toHaveLength(1)
  })

  it.each(['0001-01-01', '2024-02-29', '9999-12-31'])('uses bounded date pickers and sends the exact purchase date %s', async date => {
    await editForm()
    for (const label of ['Purchase date', 'Warranty start date']) {
      expect(screen.getByLabelText(label)).toHaveAttribute('type', 'date')
      expect(screen.getByLabelText(label)).toHaveAttribute('min', '0001-01-01')
      expect(screen.getByLabelText(label)).toHaveAttribute('max', '9999-12-31')
    }
    change('Purchase date', date)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByRole('button', { name: 'Edit computer' })
    expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({ purchaseDate: date })
  })

  it('rejects out-of-range date input without suggesting a connection failure', async () => {
    await editForm()
    change('Purchase date', '10000-01-01')
    fireEvent.submit(screen.getByRole('form', { name: 'Edit computer' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Purchase date must be YYYY-MM-DD, years 0001–9999.')
    expect(screen.getByRole('alert')).not.toHaveTextContent('No automatic write retry')
    expect(writes()).toHaveLength(0)
  })

  it('does not silently clear a partially typed invalid date', async () => {
    await editForm()
    const input = screen.getByLabelText('Purchase date') as HTMLInputElement
    vi.spyOn(input, 'validity', 'get').mockReturnValue({ badInput: true } as ValidityState)
    change('Name *', 'Changed')
    fireEvent.submit(screen.getByRole('form', { name: 'Edit computer' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Purchase date must be YYYY-MM-DD')
    expect(writes()).toHaveLength(0)
  })

  it('warns after a failed create and never retries it automatically', async () => {
    await createForm()
    change('Name *', 'New computer'); change('Asset number *', 'PC-NEW'); change('Type *', 'laptop')
    change('Purchase date', '2026-09-21')
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (init?.method === 'POST') throw new Error('Connection lost')
      return mockAPI(url, init)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save computer' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('after a connection failure, check the list before retrying a create')
    expect(screen.getByLabelText('Purchase date')).toHaveValue('2026-09-21')
    expect(writes()).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Save computer' })).toBeEnabled()
  })

  it('searches only the current page, paginates and resets page on filter/size changes', async () => {
    await mount()
    change('Search this page', 'missing')
    expect(screen.getByText('No matches on this page.')).toBeVisible()
    change('Search this page', 'SER-001')
    expect(screen.getByText('Manual workstation')).toBeVisible()
    change('Search this page', '')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Second page computer')
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(screen.getByText(/Page 2 of 2/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    await screen.findByText('Manual workstation')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    await screen.findByText('Second page computer')
    change('Rows per page', '50')
    await screen.findByText(/Page 1 of 1/)
    change('Entity filter', ids.other)
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/api/admin/assets?page=1&pageSize=50&entityId=${ids.other}`, expect.anything()))
  })

  it.each(['list', 'options', 'detail'])('shows recoverable %s failure without fabricated data', async target => {
    if (target === 'detail') {
      await mount(); fail = target; fireEvent.click(screen.getByRole('button', { name: 'Details for PC-001' }))
    } else { fail = target; render(<AdminAssetsPage token="fixture-token" onDenied={vi.fn()} />) }
    await screen.findByRole('alert')
    fail = ''
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    if (target === 'detail') expect(await screen.findByRole('button', { name: 'Edit computer' })).toBeVisible()
    else expect(await screen.findByRole('button', { name: 'Details for PC-001' })).toBeVisible()
  })

  it('ignores stale entity option responses after a second selection', async () => {
    await editForm()
    const pending = deferred<Response>()
    vi.mocked(fetch).mockImplementation((url, init) => String(url).includes(`/options?entityId=${ids.other}`) ? pending.promise : mockAPI(url, init))
    change('Entity *', ids.other); change('Entity *', ids.entity)
    await waitFor(() => expect(screen.getByLabelText('Location')).toBeEnabled())
    await act(async () => pending.resolve(json({ ...options, locations: [{ id: ids.location, name: 'Stale location' }] })))
    expect(screen.queryByText('Stale location')).not.toBeInTheDocument()
    expect(within(screen.getByLabelText('Location')).getByText('HQ')).toBeInTheDocument()
  })

  it('ignores a late detail after navigating back to list', async () => {
    await mount()
    const pending = deferred<Response>()
    vi.mocked(fetch).mockImplementation((url, init) => String(url).endsWith(`/assets/${ids.asset}`) ? pending.promise : mockAPI(url, init))
    fireEvent.click(screen.getByRole('button', { name: 'Details for PC-001' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to computers' }))
    await act(async () => pending.resolve(json({ ...computer, name: 'Stale detail' })))
    expect(screen.queryByText('Stale detail')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit computer' })).not.toBeInTheDocument()
  })

  it('ignores a late pagination response after changing page size', async () => {
    await mount()
    const pending = deferred<Response>()
    vi.mocked(fetch).mockImplementation((url, init) => String(url).includes('page=2&') ? pending.promise : mockAPI(url, init))
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.queryByText('Manual workstation')).not.toBeInTheDocument()
    change('Rows per page', '50')
    await screen.findByText(/Page 1 of 1/)
    await act(async () => pending.resolve(json({ items: [{ ...computer, name: 'Stale page two' }], total: 26, page: 2, pageSize: 25 })))
    expect(screen.queryByText('Stale page two')).not.toBeInTheDocument()
    expect(screen.getByText(/Page 1 of 1/)).toBeVisible()
  })

  it.each(['network', 'nonJSON', '500'])('preserves edit values after a %s write failure without auto-retry', async failure => {
    await editForm()
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (init?.method !== 'PATCH') return mockAPI(url, init)
      if (failure === 'network') throw new Error('Connection lost')
      return failure === 'nonJSON' ? new Response('<html>unavailable</html>', { status: 502 }) : json({ error: 'Computer operation failed' }, 500)
    })
    change('Name *', 'Keep my changes')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByRole('alert')
    expect(screen.getByLabelText('Name *')).toHaveValue('Keep my changes')
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
    expect(writes()).toHaveLength(1)
    expect(screen.queryByText('<html>unavailable</html>')).not.toBeInTheDocument()
  })

  it('aborts a pending write on unmount and ignores its late response', async () => {
    const view = await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Details for PC-001' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit computer' }))
    await waitFor(() => expect(screen.getByLabelText('Location')).toBeEnabled())
    const pending = deferred<Response>()
    vi.mocked(fetch).mockImplementation((url, init) => init?.method === 'PATCH' ? pending.promise : mockAPI(url, init))
    change('Name *', 'Late write')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    const signal = writes()[0][1]?.signal
    view.unmount()
    expect(signal?.aborted).toBe(true)
    const callCount = vi.mocked(fetch).mock.calls.length
    await act(async () => pending.resolve(json({ ...computer, name: 'Late write' })))
    expect(fetch).toHaveBeenCalledTimes(callCount)
    expect(view.onDenied).not.toHaveBeenCalled()
  })

  it('clears drafts on account changes without depending on the App shell', async () => {
    await editForm()
    change('Name *', 'Private unsaved draft')
    act(() => {
      localStorage.setItem('itms_token', 'another-account')
      window.dispatchEvent(new Event('itms-auth-changed'))
    })
    expect(screen.queryByDisplayValue('Private unsaved draft')).not.toBeInTheDocument()
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Account changed')
    expect(writes()).toHaveLength(0)
  })

  it('can save after a redundant same-account auth notification', async () => {
    await editForm()
    act(() => window.dispatchEvent(new Event('itms-auth-changed')))
    change('Name *', 'Same account edit')
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByRole('button', { name: 'Edit computer' })
    expect(writes()).toHaveLength(1)
    expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({ name: 'Same account edit' })
  })
})