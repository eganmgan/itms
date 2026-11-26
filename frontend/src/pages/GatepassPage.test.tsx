import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatepassPage } from './GatepassPage'
import { exportElementPdf } from '../lib/exports'
import { GatepassRecordPicker } from './GatepassRecordPicker'
import { notifyRecordChange } from '../lib/recordChanges'

vi.mock('jsbarcode', () => ({ default: vi.fn() }))
vi.mock('../lib/exports', () => ({ exportCsv: vi.fn(), exportElementPdf: vi.fn().mockResolvedValue(undefined) }))

const option = (kind: string, id: string, name: string, entityId: string, extra = {}) => ({ kind, id, name, entityId, locationId: '', reference: '', serial: '', department: '', role: '', ...extra })
const records = [
  option('entity', 'sender', 'Saved Sender Ltd', 'sender'),
  option('entity', 'receiver', 'Saved Receiver Ltd', 'receiver'),
  option('asset', 'asset', 'Recorded laptop', 'sender', { locationId: 'origin', reference: 'AST-1092', serial: 'REAL-SERIAL', department: 'Saved IT' }),
  option('branch', 'origin', 'Saved Origin', 'sender'),
  option('branch', 'destination', 'Saved Destination', 'receiver'),
  option('recipient', 'person', 'Recorded receiver', 'receiver', { reference: 'E1' }),
  option('recipient', 'approver', 'Recorded approver', 'sender', { role: 'it_team' }),
]
const snapshot = { version: 1, sender: { entityId: 'sender', name: 'Historical Sender Ltd', source: 'assets.entity_id' }, receiver: { entityId: 'receiver', name: 'Historical Receiver Ltd', source: 'recipient.entity_id' }, asset: records[2], origin: records[3], destination: records[4], recipient: records[5], approver: records[6], returnDate: '' }
const pass = { id: 'pass-1', gatepassNumber: 'GP-TEST-1', assetRef: 'AST-1092', assetDescription: 'Recorded laptop', purpose: 'Transfer', originBranch: 'Cochin', recipientBranch: 'Kozhikode', issueDate: '2026-09-21', employeeName: 'Recorded receiver', employeeCode: 'E1', departmentName: 'IT', contactNumber: '', status: 'approved', createdAt: '2026-09-21T09:00:00Z', approverName: 'Recorded approver', requesterName: 'Recorded requester', receiverSignedName: '', securitySignedName: '', hasReceiverSignedUpload: false, recordSnapshot: snapshot }
const writes = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')
async function waitForChoices(dialog: HTMLElement) {
  const input = within(dialog).getByRole('combobox', { name: 'Asset ID' })
  fireEvent.focus(input)
  await within(dialog).findAllByRole('option', { name: /AST-/ })
  fireEvent.blur(input)
}
function changeField(dialog: HTMLElement, label: string, value: string) {
  const input = within(dialog).getByLabelText(label)
  if (input.getAttribute('role') !== 'combobox') {
    fireEvent.change(input, { target: { value } })
    return
  }
  if (!value) {
    fireEvent.click(within(dialog).getByRole('button', { name: `Clear ${label}` }))
    return
  }
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value } })
  const choice = within(dialog).getAllByRole('option').find(item => item.getAttribute('data-record-id') === value)
  if (!choice) throw new Error(`Missing saved ${label}: ${value}`)
  fireEvent.click(choice)
  fireEvent.blur(input)
}
function expectField(dialog: HTMLElement, label: string, value: string) {
  const record = records.find(item => item.id === value)
  const display = record ? label === 'Asset ID' ? record.reference : record.name : value
  expect(within(dialog).getByLabelText(label)).toHaveValue(display)
}
async function openCompletion() {
  render(<GatepassPage />)
  await screen.findByText('GP-TEST-1')
  fireEvent.click(screen.getByRole('button', { name: 'Complete' }))
  return screen.getByRole('dialog', { name: /Record handwritten sign-off/ })
}

describe('saved record suggestions', () => {
  const choices = [
    { id: 'sender', label: 'Saved Sender Ltd', display: 'Saved Sender Ltd', keywords: 'SND' },
    { id: 'receiver', label: 'Other Company', display: 'Other Company', keywords: 'OTH' },
  ]

  it('opens matching suggestions on one character and selects a saved ID on click', () => {
    const onSelect = vi.fn()
    render(<GatepassRecordPicker label="Company" value="" choices={choices} onSelect={onSelect} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 's' } })
    expect(screen.getByRole('option', { name: 'Saved Sender Ltd' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'Other Company' })).not.toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('option', { name: 'Saved Sender Ltd' }))
    expect(onSelect).toHaveBeenCalledWith('sender')
  })

  it('supports keyboard selection, Escape and unknown text without inventing records', () => {
    const onSelect = vi.fn()
    render(<GatepassRecordPicker label="Company" value="sender" choices={choices} onSelect={onSelect} />)
    const input = screen.getByRole('combobox')
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('receiver')
    onSelect.mockClear()
    fireEvent.change(input, { target: { value: 'unknown' } })
    expect(screen.getByText('No matching saved records.')).toBeVisible()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('Saved Sender Ltd')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})

describe('handwritten gatepass signatures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.setItem('itms_token', 'fixture-token')
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST' ? { status: 'completed', gatepassNumber: 'GP-NEW' } : String(url).endsWith('/options') ? { items: records } : String(url).includes('/audit') ? [] : { items: [pass], total: 1 }), { status: 200 })))
  })
  afterEach(() => { localStorage.clear(); vi.unstubAllGlobals() })

  it('renders blank handwriting spaces in the preview and exported PDF without signing', async () => {
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'View / PDF' }))
    const doc = document.getElementById('printable-gatepass-doc')!
    expect(doc).not.toHaveTextContent('Electronically Signed')
    expect(doc).not.toHaveTextContent('Digitally authorized')
    expect(doc).toHaveTextContent('No electronic signature is applied')
    expect(doc).toHaveTextContent('Historical Sender Ltd')
    expect(doc).toHaveTextContent('Historical Receiver Ltd')
    expect(doc).toHaveTextContent('REAL-SERIAL')
    expect(doc).toHaveTextContent('Issue date: 2026-09-21')
    expect(doc).not.toHaveTextContent('Enterprise Tech')
    expect(doc).not.toHaveTextContent('Dell Latitude')
    expect(doc).not.toHaveTextContent('Aug 08')
    expect(doc).not.toHaveTextContent('DL7450-X8Q29')
    for (const role of ['IT Team Approver', 'Security Checkpoint', 'Receiver / Employee']) {
      expect(within(doc).getByLabelText(`${role} signature space`)).toBeEmptyDOMElement()
    }
    expect(within(doc).getAllByText('Name: __________________')).toHaveLength(3)
    expect(within(doc).getAllByText('Date: ___________________')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Download Full Gatepass PDF' }))
    expect(exportElementPdf).toHaveBeenCalledWith(doc, 'GP-TEST-1-full-gatepass.pdf')
    expect(writes()).toHaveLength(0)
  })

  it('does not sign or complete on opening/cancelling, and resets names on reopening', async () => {
    const dialog = await openCompletion()
    expectField(dialog, 'Receiver signatory name', '')
    expectField(dialog, 'Security signatory name', '')
    expect(within(dialog).getByRole('button', { name: 'Record completion' })).toBeDisabled()
    changeField(dialog, 'Receiver signatory name', 'Written name')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(writes()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }))
    expect(screen.getByLabelText('Receiver signatory name')).toHaveValue('')
  })

  it('records only manually entered signatory names after paper-signature confirmation', async () => {
    const dialog = await openCompletion()
    changeField(dialog, 'Receiver signatory name', ' Actual Receiver ')
    changeField(dialog, 'Security signatory name', ' Actual Officer ')
    expect(within(dialog).getByRole('button', { name: 'Record completion' })).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record completion' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes()).toHaveLength(1)
    expect(writes()[0][0]).toBe('/api/gatepass/pass-1/complete')
    expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({ receiverSignedName: 'Actual Receiver', securitySignedName: 'Actual Officer' })
  })

  it('preserves entered names after a connection failure without automatic retry', async () => {
    const dialog = await openCompletion()
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Connection lost'))
    changeField(dialog, 'Receiver signatory name', 'Actual Receiver')
    changeField(dialog, 'Security signatory name', 'Actual Officer')
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record completion' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Check the gatepass list before retrying')
    expect(writes()).toHaveLength(1)
    expectField(dialog, 'Security signatory name', 'Actual Officer')
  })

  it('blocks official export for legacy records rather than inventing company or asset details', async () => {
    vi.mocked(fetch).mockImplementation(async url => new Response(JSON.stringify(String(url).includes('/audit') ? [] : { items: [{ ...pass, assetRef: 'REAL-UNKNOWN-ASSET', recordSnapshot: undefined }] })))
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'View / PDF' }))
    const doc = document.getElementById('printable-gatepass-doc')!
    expect(doc).toHaveTextContent('INCOMPLETE GATEPASS')
    expect(doc).toHaveTextContent('REAL-UNKNOWN-ASSET')
    expect(doc).not.toHaveTextContent('AST-1092')
    expect(screen.getByRole('button', { name: 'Download Full Gatepass PDF' })).toBeDisabled()
    expect(exportElementPdf).not.toHaveBeenCalled()
  })

  it('does not show demo records or allow creation while signed out or unavailable', async () => {
    localStorage.clear()
    render(<GatepassPage />)
    expect(screen.getByRole('button', { name: 'Create Gatepass' })).toBeDisabled()
    expect(screen.queryByText('Demo data')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'View / PDF' })).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['Company Sender', 'Receiver Company', 'From Branch', 'To Branch', 'Recipient (person)', 'Asset ID', 'Item Name', 'Serial Number', 'Department', 'IT Approver', 'Search saved companies and assets'])('shows saved record suggestions for one letter in %s', async label => {
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
    const dialog = screen.getByRole('dialog')
    await waitForChoices(dialog)
    const input = within(dialog).getByRole('combobox', { name: label })
    fireEvent.change(input, { target: { value: 's' } })
    expect(within(dialog).getByRole('listbox', { name: `${label} suggestions` })).toBeVisible()
    expect(within(dialog).getAllByRole('option').length).toBeGreaterThan(0)
    expect(writes()).toHaveLength(0)
  })

  it.each(['manual', 'same-tab', 'other-tab', 'focus'])('refreshes companies and branches on %s updates without discarding the gatepass draft', async trigger => {
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
    const dialog = screen.getByRole('dialog')
    await waitForChoices(dialog)
    const add = within(dialog).getByRole('link', { name: 'Add company, branch or asset' })
    expect(add).toHaveAttribute('href', '/settings')
    expect(add).toHaveAttribute('target', '_blank')
    changeField(dialog, 'Asset ID', 'asset')
    changeField(dialog, 'Purpose of Movement', 'Repair')
    changeField(dialog, 'Dispatch Date', '2026-10-08')
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ items: [
      ...records,
      option('entity', 'new-company', 'New Saved Company', 'new-company'),
      option('branch', 'new-origin', 'New Origin Branch', 'sender'),
      option('branch', 'new-destination', 'New Destination Branch', 'new-company'),
    ] })))
    if (trigger === 'manual') fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh saved records' }))
    else act(() => {
      if (trigger === 'same-tab') notifyRecordChange()
      else if (trigger === 'other-tab') window.dispatchEvent(new StorageEvent('storage', { key: 'itms-records-changed', newValue: 'revision' }))
      else window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Refresh saved records' })).toBeEnabled())
    changeField(dialog, 'Receiver Company', 'new-company')
    changeField(dialog, 'From Branch', 'new-origin')
    changeField(dialog, 'To Branch', 'new-destination')
    expectField(dialog, 'From Branch', 'New Origin Branch')
    expectField(dialog, 'To Branch', 'New Destination Branch')
    expectField(dialog, 'Company Sender', 'sender')
    expectField(dialog, 'Receiver Company', 'New Saved Company')
    expectField(dialog, 'Asset ID', 'asset')
    expectField(dialog, 'Purpose of Movement', 'Repair')
    expectField(dialog, 'Dispatch Date', '2026-10-08')
    expect(writes()).toHaveLength(0)
  })

  it('selects a sender company suggestion before an asset and keeps the creation guard', async () => {
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
    const dialog = screen.getByRole('dialog')
    await waitForChoices(dialog)
    changeField(dialog, 'Company Sender', 'sender')
    expectField(dialog, 'Company Sender', 'sender')
    expectField(dialog, 'Asset ID', '')
    expect(within(dialog).getByRole('button', { name: 'Create Gatepass' })).toBeDisabled()
    changeField(dialog, 'Asset ID', 'asset')
    changeField(dialog, 'Receiver Company', 'receiver')
    expectField(dialog, 'Company Sender', 'sender')
    expectField(dialog, 'Receiver Company', 'receiver')
    expect(writes()).toHaveLength(0)
  })

  it('derives companies from saved selections and sends IDs, not display names', async () => {
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
    const dialog = screen.getByRole('dialog')
    await waitForChoices(dialog)
    expectField(dialog, 'Dispatch Date', '')
    expect(within(dialog).getByRole('button', { name: 'Download Full Gatepass PDF' })).toBeDisabled()
    changeField(dialog, 'Asset ID', 'asset')
    expectField(dialog, 'Company Sender', 'Saved Sender Ltd')
    expect(within(dialog).getByLabelText('Company Sender')).toHaveAccessibleDescription('Sender company detected from the selected asset.')
    expect(within(dialog).getByLabelText('Company Sender')).toHaveAttribute('role', 'combobox')
    expectField(dialog, 'From Branch', 'origin')
    changeField(dialog, 'Recipient (person)', 'person')
    expectField(dialog, 'Receiver Company', 'Saved Receiver Ltd')
    expect(within(dialog).getByLabelText('Receiver Company')).toHaveAccessibleDescription('Receiver company detected from the selected recipient.')
    changeField(dialog, 'IT Approver', 'approver')
    changeField(dialog, 'Dispatch Date', '2026-09-21')
    changeField(dialog, 'Purpose of Movement', 'Repair')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Gatepass' }))
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(JSON.parse(String(writes()[0][1]?.body))).toEqual({ assetId: 'asset', originBranchId: 'origin', recipientBranchId: '', recipientId: 'person', receiverEntityId: '', approverId: 'approver', purpose: 'Repair', issueDate: '2026-09-21', returnDate: '', contactNumber: '' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('detects company from destination alone and clears it when the selection is removed', async () => {
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
    const dialog = screen.getByRole('dialog')
    await waitForChoices(dialog)
    changeField(dialog, 'To Branch', 'destination')
    expectField(dialog, 'Receiver Company', 'Saved Receiver Ltd')
    expect(within(dialog).getByLabelText('Receiver Company')).toHaveAccessibleDescription('Receiver company detected from the destination branch.')
    expect(within(dialog).getByRole('combobox', { name: 'Receiver Company' })).toBeVisible()
    changeField(dialog, 'To Branch', '')
    expectField(dialog, 'Receiver Company', '')
    expectField(dialog, 'Receiver Company', '')
    expect(writes()).toHaveLength(0)
  })

  it('searches saved assets by company and serial without accepting free-text identities', async () => {
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
    const dialog = screen.getByRole('dialog')
    await waitForChoices(dialog)
    const search = within(dialog).getByRole('combobox', { name: 'Search saved companies and assets' })
    fireEvent.change(search, { target: { value: 'Saved Sender' } })
    expect(within(dialog).getByRole('option', { name: 'Asset: AST-1092 · Recorded laptop' })).toBeVisible()
    fireEvent.change(search, { target: { value: 'not a saved company' } })
    expect(within(dialog).queryByRole('option', { name: 'Asset: AST-1092 · Recorded laptop' })).not.toBeInTheDocument()
    expectField(dialog, 'Asset ID', '')
    fireEvent.change(search, { target: { value: 'real-serial' } })
    changeField(dialog, 'Asset ID', 'asset')
    fireEvent.change(search, { target: { value: 'Saved Receiver' } })
    expectField(dialog, 'Asset ID', 'asset')
    expectField(dialog, 'Company Sender', 'Saved Sender Ltd')
    expect(within(dialog).getByRole('option', { name: 'Company: Saved Receiver Ltd' })).toBeVisible()
    expect(writes()).toHaveLength(0)
  })

  it('fills company fields when an exact asset search is entered before options finish loading', async () => {
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    let resolveOptions!: (response: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOptions = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Search saved companies and assets' }), { target: { value: 'spare.zho-0007' } })
    const items = records.map(item => item.id === 'asset' ? { ...item, name: 'spare.zho-0007', assignedUserId: 'person' } : item)
    await act(async () => resolveOptions(new Response(JSON.stringify({ items }))))
    expectField(dialog, 'Asset ID', 'asset')
    expectField(dialog, 'Company Sender', 'Saved Sender Ltd')
    expectField(dialog, 'Receiver Company', 'Saved Receiver Ltd')
    expect(writes()).toHaveLength(0)
  })

  it('selects a unique exact typed asset and fills its saved fields', async () => {
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
    const dialog = screen.getByRole('dialog')
    await waitForChoices(dialog)
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Search saved companies and assets' }), { target: { value: ' real-serial ' } })
    for (const [label, value] of [['Asset ID', 'asset'], ['Company Sender', 'Saved Sender Ltd'], ['From Branch', 'origin'], ['Item Name', 'Recorded laptop'], ['Serial Number', 'REAL-SERIAL'], ['Department', 'Saved IT']]) {
      expectField(dialog, label, value)
    }
    expect(writes()).toHaveLength(0)
  })

  it('fills the assigned recipient, saved destination and sole sender approver, then clears automatic values on asset change', async () => {
    const items = records.map(item => item.id === 'asset' ? { ...item, assignedUserId: 'person' } : item.id === 'person' ? { ...item, locationId: 'destination' } : item)
    items.push(option('asset', 'unassigned', 'Unassigned laptop', 'receiver', { reference: 'AST-2' }))
    vi.mocked(fetch).mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith('/options') ? { items } : String(url).includes('/audit') ? [] : { items: [pass] })))
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
    const dialog = screen.getByRole('dialog')
    await waitForChoices(dialog)
    changeField(dialog, 'Asset ID', 'asset')
    for (const [label, value] of [['Recipient (person)', 'person'], ['Receiver Company', 'Saved Receiver Ltd'], ['To Branch', 'destination'], ['IT Approver', 'approver']]) {
      expectField(dialog, label, value)
    }
    expectField(dialog, 'Contact Phone', '')
    changeField(dialog, 'Contact Phone', '5550100')
    changeField(dialog, 'Asset ID', 'unassigned')
    for (const label of ['Recipient (person)', 'Receiver Company', 'To Branch', 'IT Approver', 'Contact Phone']) {
      expectField(dialog, label, '')
    }
    expect(writes()).toHaveLength(0)
  })

  it('preserves explicit movement choices when selecting an asset', async () => {
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
    const dialog = screen.getByRole('dialog')
    await waitForChoices(dialog)
    for (const [label, value] of [['Recipient (person)', 'person'], ['To Branch', 'destination'], ['IT Approver', 'approver'], ['Contact Phone', '5550100'], ['Asset ID', 'asset']]) {
      changeField(dialog, label, value)
    }
    for (const [label, value] of [['Recipient (person)', 'person'], ['To Branch', 'destination'], ['IT Approver', 'approver'], ['Contact Phone', '5550100']]) {
      expectField(dialog, label, value)
    }
    expect(writes()).toHaveLength(0)
  })

  it('does not guess an unavailable assigned recipient or choose among multiple sender approvers', async () => {
    const items = [...records.map(item => item.id === 'asset' ? { ...item, assignedUserId: 'unauthorized' } : item), option('recipient', 'other-approver', 'Another approver', 'sender', { role: 'admin' })]
    vi.mocked(fetch).mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith('/options') ? { items } : String(url).includes('/audit') ? [] : { items: [pass] })))
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
    const dialog = screen.getByRole('dialog')
    await waitForChoices(dialog)
    changeField(dialog, 'Asset ID', 'asset')
    for (const label of ['Recipient (person)', 'Receiver Company', 'To Branch', 'IT Approver']) {
      expectField(dialog, label, '')
    }
    expect(writes()).toHaveLength(0)
  })

  it('does not choose an asset from an ambiguous name or company search', async () => {
    const items = [...records, { ...records[2], id: 'asset-2', reference: 'AST-2', serial: 'SERIAL-2' }]
    vi.mocked(fetch).mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith('/options') ? { items } : String(url).includes('/audit') ? [] : { items: [pass] })))
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
    const dialog = screen.getByRole('dialog')
    await waitForChoices(dialog)
    for (const value of ['Recorded laptop', 'Saved Sender Ltd', 'AST-']) {
      fireEvent.change(within(dialog).getByRole('combobox', { name: 'Search saved companies and assets' }), { target: { value } })
      expectField(dialog, 'Asset ID', '')
    }
    expect(writes()).toHaveLength(0)
  })

  it('detects sender from origin first and recipient destination from saved location', async () => {
    const items = records.map(item => item.id === 'person' ? { ...item, locationId: 'destination' } : item)
    vi.mocked(fetch).mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith('/options') ? { items } : String(url).includes('/audit') ? [] : { items: [pass] })))
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
    const dialog = screen.getByRole('dialog')
    await waitForChoices(dialog)
    changeField(dialog, 'From Branch', 'origin')
    expectField(dialog, 'Company Sender', 'Saved Sender Ltd')
    expect(within(dialog).getByLabelText('Company Sender')).toHaveAccessibleDescription('Sender company detected from the origin branch.')
    changeField(dialog, 'Recipient (person)', 'person')
    expectField(dialog, 'To Branch', 'destination')
    expectField(dialog, 'Receiver Company', 'Saved Receiver Ltd')
    expect(writes()).toHaveLength(0)
  })

  it('updates sender company and origin together when changing or clearing an asset', async () => {
    const options = [...records, option('asset', 'second-asset', 'Second laptop', 'receiver', { reference: 'AST-2', locationId: 'destination' })]
    vi.mocked(fetch).mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith('/options') ? { items: options } : String(url).includes('/audit') ? [] : { items: [pass] })))
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
    const dialog = screen.getByRole('dialog')
    await waitForChoices(dialog)
    changeField(dialog, 'Asset ID', 'asset')
    expectField(dialog, 'Company Sender', 'Saved Sender Ltd')
    changeField(dialog, 'Asset ID', 'second-asset')
    expectField(dialog, 'Company Sender', 'Saved Receiver Ltd')
    expectField(dialog, 'From Branch', 'destination')
    changeField(dialog, 'Asset ID', '')
    expectField(dialog, 'Company Sender', '')
    expectField(dialog, 'From Branch', '')
    expect(writes()).toHaveLength(0)
  })

  it('blocks creation when the asset company cannot be resolved without guessing a name', async () => {
    vi.mocked(fetch).mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith('/options') ? { items: records.filter(item => !(item.kind === 'entity' && item.id === 'sender')) } : String(url).includes('/audit') ? [] : { items: [pass] })))
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
    const dialog = screen.getByRole('dialog')
    await waitForChoices(dialog)
    for (const [label, value] of [['Asset ID', 'asset'], ['Recipient (person)', 'person'], ['IT Approver', 'approver'], ['Dispatch Date', '2026-09-22'], ['Purpose of Movement', 'Repair']]) {
      changeField(dialog, label, value)
    }
    expectField(dialog, 'Company Sender', '')
    expect(within(dialog).getByLabelText('Company Sender')).toHaveAccessibleDescription(/saved company is unavailable/)
    expect(within(dialog).getByRole('button', { name: 'Create Gatepass' })).toBeDisabled()
    fireEvent.submit(within(dialog).getByRole('button', { name: 'Create Gatepass' }).closest('form')!)
    expect(writes()).toHaveLength(0)
  })

  it('filters receiver records to the explicitly selected company', async () => {
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
    const dialog = screen.getByRole('dialog')
    await waitForChoices(dialog)
    expectField(dialog, 'Receiver Company', '')
    changeField(dialog, 'Receiver Company', 'receiver')
    expectField(dialog, 'Receiver Company', 'Saved Receiver Ltd')
    changeField(dialog, 'Recipient (person)', 'person')
    fireEvent.focus(within(dialog).getByLabelText('To Branch'))
    expect(within(dialog).queryByRole('option', { name: /Saved Origin/ })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('option', { name: /Saved Destination/ })).toBeInTheDocument()
    expect(writes()).toHaveLength(0)
  })

  it('clears historical return dates and keeps saved fields read-only', async () => {
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    fireEvent.click(screen.getByRole('button', { name: 'View / PDF' }))
    expect(screen.getByLabelText('Expected Return Date')).toHaveValue('')
    expect(screen.getByLabelText('Receiver Company')).toBeDisabled()
    expect(screen.getByLabelText('Purpose of Movement')).toHaveAttribute('readonly')
  })

  it('shows API failures without falling back to invented official documents', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Records unavailable'))
    render(<GatepassPage />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Records unavailable')
    expect(screen.getByRole('button', { name: 'Create Gatepass' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'View / PDF' })).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('Enterprise Tech')
    expect(document.body).not.toHaveTextContent('GP-2026-084')
  })

  it('discards a delayed authorized-record response after sign-out', async () => {
    render(<GatepassPage />)
    await screen.findByText('GP-TEST-1')
    let resolveOptions!: (response: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOptions = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await act(async () => {
      localStorage.removeItem('itms_token')
      window.dispatchEvent(new Event('itms-auth-changed'))
      resolveOptions(new Response(JSON.stringify({ items: records })))
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('GP-TEST-1')).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('Saved Sender Ltd')
  })
})