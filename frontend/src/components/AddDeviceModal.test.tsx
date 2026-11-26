import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AddDeviceModal } from './AddDeviceModal'

describe('AddDeviceModal', () => {
  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('creates a manually entered stock device', async () => {
    localStorage.setItem('itms_token', 'test-token')
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => Promise.resolve({
      ok: true,
      json: async () => url.includes('/options') ? { employees: [], suppliers: [], subItems: [] } : { id: 'stock-1' },
      request: init,
    }))
    vi.stubGlobal('fetch', fetchMock)
    const onClose = vi.fn()
    const onCreated = vi.fn()

    render(<AddDeviceModal branches={[{ id: 'branch-1', name: 'Head Office' }]} onClose={onClose} onCreated={onCreated} />)
    fireEvent.change(screen.getByLabelText(/computer type/i), { target: { value: 'Desktop' } })
    fireEvent.change(screen.getAllByLabelText(/^name$/i)[0], { target: { value: 'Dell OptiPlex' } })
    fireEvent.change(screen.getByLabelText(/inventory\/asset number/i), { target: { value: 'ZBL-DEV-001' } })
    fireEvent.change(screen.getByLabelText(/warranty start date/i), { target: { value: '2026-01-31' } })
    fireEvent.change(screen.getByLabelText(/warranty duration/i), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: /add device/i }))

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
    expect(fetchMock).toHaveBeenCalledWith('/api/inventory', expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: expect.stringContaining('"category":"Desktop"'),
    }))
    const submitCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(submitCall?.[1]?.body as string)).toMatchObject({
      assetTag: 'ZBL-DEV-001',
      branchId: 'branch-1',
      category: 'Desktop',
      name: 'Dell OptiPlex',
      status: 'inventory',
      warrantyDurationMonths: '1',
      warrantyExpiresAt: '2026-02-28',
      warrantyStartDate: '2026-01-31',
    })
    expect(onCreated).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('edits and saves an existing device', async () => {
    localStorage.setItem('itms_token', 'test-token')
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ employees: [], suppliers: [], subItems: [] }) })
    vi.stubGlobal('fetch', fetchMock)

    render(<AddDeviceModal branches={[{ id: 'branch-1', name: 'Head Office' }]} device={{ id: 'stock-1', itemCode: 'STK-1', category: 'Laptop', name: 'ThinkPad', assetTag: 'ASSET-1', branchId: 'branch-1', branchName: 'Head Office', status: 'inventory' }} mode="edit" onClose={vi.fn()} onCreated={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/serial number/i), { target: { value: 'SERIAL-2' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/inventory/stock-1', expect.objectContaining({ method: 'PATCH' })))
    const saveCall = fetchMock.mock.calls.find(([url, init]) => url === '/api/inventory/stock-1' && init?.method === 'PATCH')
    expect(JSON.parse(saveCall?.[1]?.body as string)).toMatchObject({ serialNumber: 'SERIAL-2', branchId: 'branch-1' })
  })

  it('shows device details and opens edit mode', () => {
    const onEdit = vi.fn()
    render(<AddDeviceModal branches={[]} device={{ id: 'stock-1', itemCode: 'STK-1', category: 'Desktop', name: 'Finance Desktop', assetTag: 'ASSET-1', manufacturer: 'Dell', warrantyExpiresAt: '2028-01-31', status: 'allocated' }} mode="details" onClose={vi.fn()} onCreated={vi.fn()} onEdit={onEdit} />)

    expect(screen.getByText('Finance Desktop')).toBeInTheDocument()
    expect(screen.getByText('Dell')).toBeInTheDocument()
    expect(screen.getByText('2028-01-31')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /edit device/i }))
    expect(onEdit).toHaveBeenCalledOnce()
  })
})