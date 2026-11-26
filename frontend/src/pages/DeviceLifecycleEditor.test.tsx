import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DeviceLifecycleEditor } from './DeviceLifecycleEditor'
import { DeviceOverviewPage } from './DeviceOverviewPage'

beforeEach(() => { localStorage.setItem('itms_token', 'lifecycle-test'); vi.stubGlobal('fetch', vi.fn()) })
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })
const mount = (allowed = true) => render(<DeviceLifecycleEditor assetId="asset-a" detail={{ canEditLifecycle: allowed, cost: 0, warrantyDurationMonths: 0 }} onSaved={vi.fn()} />)
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Edit asset details' }))
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }))

it('requires server permission, not a cached super admin profile', () => {
  localStorage.setItem('itms_user', JSON.stringify({ role: 'super_admin' }))
  mount(false)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

it('groups all three sections and does not consume an unchanged save', () => {
  mount(); open()
  for (const name of ['Management - Asset Lifecycle', 'Financial & Administrative Information', 'Warranty Information']) expect(screen.getByRole('group', { name })).toBeVisible()
  expect(screen.getByLabelText('Value')).toHaveValue(0)
  expect(screen.getByLabelText('Warranty duration (months)')).toHaveValue(0)
  save()
  expect(screen.getByRole('alert')).toHaveTextContent('No changes')
  expect(fetch).not.toHaveBeenCalled()
})

it.each([false, true])('uses server permission after saving: editable=%s', async editable => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ok: true, canEditLifecycle: editable })))
  mount(); open()
  fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'Saved supplier' } })
  const button = screen.getByRole('button', { name: 'Save' })
  fireEvent.click(button); fireEvent.click(button)
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ supplierName: 'Saved supplier' })
  if (editable) expect(screen.getByRole('button', { name: 'Edit asset details' })).toBeEnabled()
  else expect(screen.getByRole('button', { name: 'Edit asset details' })).toBeDisabled()
})

it('blocks retries when another IT team member has saved first', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: 'IT team edit already used' }), { status: 409 }))
  mount(); open()
  fireEvent.change(screen.getByLabelText('Value'), { target: { value: '100' } }); save()
  expect(await screen.findByRole('alert')).toHaveTextContent('already used')
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
})

it('blocks retry after an uncertain network result', async () => {
  vi.mocked(fetch).mockRejectedValue(new Error('network'))
  mount(); open()
  fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'Supplier' } }); save()
  expect(await screen.findByRole('alert')).toHaveTextContent('Save result unknown')
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
})

it('keeps a rejected validation editable without losing entered fields', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: 'Invalid purchase date' }), { status: 400 }))
  mount(); open()
  fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'Correct supplier' } }); save()
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid purchase date')
  expect(screen.getByLabelText('Supplier')).toHaveValue('Correct supplier')
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
})

it('integrates with device details and removes IT editing after refreshing the saved record', async () => {
  let used = false
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    if (init?.method === 'PATCH') { used = true; return new Response(JSON.stringify({ ok: true, canEditLifecycle: false })) }
    return new Response(JSON.stringify(String(url).endsWith('/asset-a') ? { name: 'Lifecycle device', canEditLifecycle: !used } : []))
  })
  render(<DeviceOverviewPage device={{ id: 'owner-a', primaryAssetId: 'asset-a', fullName: 'Owner', email: 'owner@example.test', employeeCode: 'EMP1', departmentName: '', branchName: '', assetCount: 1, newAssetCount: 0, ungroupedAssetCount: 0, flaggedAssetCount: 0, status: 'offline' }} />)
  await screen.findByRole('button', { name: 'Edit asset details' })
  open(); fireEvent.change(screen.getByLabelText('Supplier'), { target: { value: 'Supplier' } }); save()
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit asset details' })).not.toBeInTheDocument())
  expect(used).toBe(true)
})