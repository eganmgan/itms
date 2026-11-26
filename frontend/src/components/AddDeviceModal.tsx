import { useEffect, useId, useState, type FormEvent } from 'react'
import { PackagePlus, Pencil } from 'lucide-react'
import { Modal } from './ui'

interface LookupOption {
  id: string
  name: string
}

interface InventoryOptions {
  employees?: Array<LookupOption & { email?: string }>
  suppliers?: LookupOption[]
  subItems?: Array<{ companyName?: string }>
}

export interface ManualDeviceRecord {
  id: string
  itemCode: string
  category: string
  name: string
  assetTag: string
  serialNumber?: string
  branchId?: string
  branchName?: string
  assignedUserId?: string
  assignedUserName?: string
  technicianInChargeId?: string
  technicianInChargeName?: string
  groupInChargeId?: string
  groupInChargeName?: string
  manufacturer?: string
  supplierId?: string
  supplierName?: string
  operatingSystem?: string
  osArchitecture?: string
  purchaseDate?: string
  cost?: string
  warrantyStartDate?: string
  warrantyDurationMonths?: string
  warrantyExpiresAt?: string
  updateSources?: string
  specs?: string
  status: string
}

interface AddDeviceModalProps {
  branches: LookupOption[]
  groups?: LookupOption[]
  device?: ManualDeviceRecord
  mode?: 'add' | 'edit' | 'details'
  onClose: () => void
  onCreated: () => void
  onEdit?: () => void
}

const deviceTypes = ['Mouse', 'Keyboard', 'Laptop', 'Desktop', 'Server', 'Monitor', 'Printer', 'Other']
const statuses = [{ id: 'inventory', name: 'In stock' }, { id: 'allocated', name: 'Allocated' }, { id: 'returned', name: 'Returned' }, { id: 'retired', name: 'Retired' }]
const currency = import.meta.env.VITE_CURRENCY_CODE || 'INR'

function addMonths(startDate: string, duration: string) {
  if (!startDate || duration === '') return ''
  const months = Number(duration)
  if (!Number.isInteger(months) || months < 0) return ''
  const [year, month, day] = startDate.split('-').map(Number)
  const firstOfTarget = new Date(Date.UTC(year, month - 1 + months, 1))
  const lastDay = new Date(Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth() + 1, 0)).getUTCDate()
  return new Date(Date.UTC(firstOfTarget.getUTCFullYear(), firstOfTarget.getUTCMonth(), Math.min(day, lastDay))).toISOString().slice(0, 10)
}

function optionId(options: LookupOption[], name: string) {
  return options.find((option) => option.name === name)?.id ?? ''
}

function SearchableField({ label, value, options, onChange, required }: { label: string; value: string; options: LookupOption[]; onChange: (value: string) => void; required?: boolean }) {
  const listId = useId()
  return <label className="text-xs font-bold text-slate-500">{label}<input className="field mt-2" list={listId} value={value} onChange={(event) => onChange(event.target.value)} required={required} autoComplete="off" /><datalist id={listId}>{options.map((option) => <option key={option.id} value={option.name} />)}</datalist></label>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <fieldset className="space-y-4 border-t pt-4 first:border-t-0 first:pt-0"><legend className="mb-3 text-xs font-black uppercase tracking-widest text-brand-600">{title}</legend><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div></fieldset>
}

function Detail({ label, value }: { label: string; value?: string }) {
  return <div><dt className="text-[11px] font-bold text-slate-400">{label}</dt><dd className="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{value || 'Not set'}</dd></div>
}

export function AddDeviceModal({ branches, groups = [], device, mode = 'add', onClose, onCreated, onEdit }: AddDeviceModalProps) {
  const [options, setOptions] = useState<InventoryOptions>({})
  const [category, setCategory] = useState(device?.category ?? 'Laptop')
  const [name, setName] = useState(device?.name ?? '')
  const [assetTag, setAssetTag] = useState(device?.assetTag ?? '')
  const [serialNumber, setSerialNumber] = useState(device?.serialNumber ?? '')
  const [locationName, setLocationName] = useState(device?.branchName ?? branches[0]?.name ?? '')
  const [technicianName, setTechnicianName] = useState(device?.technicianInChargeName ?? '')
  const [groupName, setGroupName] = useState(device?.groupInChargeName ?? '')
  const [userName, setUserName] = useState(device?.assignedUserName ?? '')
  const [manufacturer, setManufacturer] = useState(device?.manufacturer ?? '')
  const [updateSources, setUpdateSources] = useState(device?.updateSources ?? '')
  const [operatingSystem, setOperatingSystem] = useState(device?.operatingSystem ?? '')
  const [osArchitecture, setOsArchitecture] = useState(device?.osArchitecture ?? '')
  const [purchaseDate, setPurchaseDate] = useState(device?.purchaseDate ?? '')
  const [supplierName, setSupplierName] = useState(device?.supplierName ?? '')
  const [cost, setCost] = useState(device?.cost ?? '')
  const [warrantyStartDate, setWarrantyStartDate] = useState(device?.warrantyStartDate ?? '')
  const [warrantyDuration, setWarrantyDuration] = useState(device?.warrantyDurationMonths ?? '')
  const [specs, setSpecs] = useState(device?.specs ?? '')
  const [status, setStatus] = useState(device?.status ?? 'inventory')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const employees = options.employees ?? []
  const suppliers = options.suppliers ?? []
  const manufacturers = Array.from(new Set((options.subItems ?? []).map((item) => item.companyName).filter((value): value is string => Boolean(value)))).map((value) => ({ id: value, name: value }))
  const warrantyExpiresAt = addMonths(warrantyStartDate, warrantyDuration) || device?.warrantyExpiresAt || ''

  useEffect(() => {
    if (mode === 'details') return
    const token = localStorage.getItem('itms_token')
    if (!token) return
    void fetch('/api/inventory/module/options', { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((payload: InventoryOptions) => setOptions(payload))
      .catch(() => setOptions({}))
  }, [mode])

  if (mode === 'details' && device) {
    const detailSections: Array<[string, Array<[string, string | undefined]>]> = [
      ['Computer Details', [['Name', device.name], ['Location', device.branchName], ['Technician in Charge', device.technicianInChargeName], ['Group in Charge', device.groupInChargeName], ['User', device.assignedUserName], ['Status', statuses.find((item) => item.id === device.status)?.name ?? device.status], ['Computer Type', device.category], ['Manufacturer', device.manufacturer], ['Serial Number', device.serialNumber], ['Inventory/Asset Number', device.assetTag], ['Update Sources', device.updateSources]]],
      ['Operating System', [['Name', device.operatingSystem], ['Architecture', device.osArchitecture]]],
      ['Management - Asset Lifecycle', [['Date of Purchase', device.purchaseDate]]],
      ['Financial & Administrative Information', [['Supplier', device.supplierName], [`Value (${currency})`, device.cost]]],
      ['Warranty Information', [['Warranty Start Date', device.warrantyStartDate], ['Warranty Duration', device.warrantyDurationMonths ? `${device.warrantyDurationMonths} months` : undefined], ['Warranty Expiry Date', device.warrantyExpiresAt]]],
    ]
    return <Modal title="Device details" onClose={onClose} size="max-w-5xl"><div className="space-y-6 p-5 sm:p-6">{detailSections.map(([title, fields]) => <section key={title}><h3 className="border-b pb-2 text-xs font-black uppercase tracking-widest text-brand-600">{title}</h3><dl className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{fields.map(([label, value]) => <Detail key={label} label={label} value={value} />)}</dl></section>)}<div className="flex justify-end gap-2 border-t pt-4"><button type="button" className="secondary-button" onClick={onClose}>Close</button>{onEdit && <button type="button" className="primary-button" onClick={onEdit}><Pencil size={16} />Edit Device</button>}</div></div></Modal>
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const token = localStorage.getItem('itms_token')
    if (!token) {
      setError('Your session has expired. Sign in again to add a device.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const response = await fetch(device ? `/api/inventory/${device.id}` : '/api/inventory', {
        method: device ? 'PATCH' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, name, assetTag, serialNumber, branchId: optionId(branches, locationName), assignedUserId: optionId(employees, userName), technicianInChargeId: optionId(employees, technicianName), groupInChargeId: optionId(groups, groupName), manufacturer, supplierId: optionId(suppliers, supplierName), operatingSystem, osArchitecture, purchaseDate, warrantyStartDate, warrantyDurationMonths: warrantyDuration, warrantyExpiresAt, updateSources, specs, cost, status }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(payload?.error || (response.status === 403 ? 'You do not have permission to add devices.' : 'Could not add the device.'))
      }
      onCreated()
      onClose()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not add the device.')
    } finally {
      setSaving(false)
    }
  }

  return <Modal title={device ? 'Edit device' : 'Add device to stock'} onClose={onClose} size="max-w-5xl"><form className="space-y-6 p-5 sm:p-6" onSubmit={(event) => void submit(event)}>
    <Section title="Computer Details">
      <label className="text-xs font-bold text-slate-500">Name<input className="field mt-2" value={name} onChange={(event) => setName(event.target.value)} required /></label>
      <SearchableField label="Location" value={locationName} options={branches} onChange={setLocationName} required />
      <SearchableField label="Technician in Charge" value={technicianName} options={employees} onChange={setTechnicianName} />
      <SearchableField label="Group in Charge" value={groupName} options={groups} onChange={setGroupName} />
      <SearchableField label="User" value={userName} options={employees} onChange={setUserName} />
      <label className="text-xs font-bold text-slate-500">Status<select className="field mt-2" value={status} onChange={(event) => setStatus(event.target.value)}>{statuses.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="text-xs font-bold text-slate-500">Computer Type<select className="field mt-2" value={category} onChange={(event) => setCategory(event.target.value)}>{deviceTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
      <SearchableField label="Manufacturer" value={manufacturer} options={manufacturers} onChange={setManufacturer} />
      <label className="text-xs font-bold text-slate-500">Serial Number<input className="field mt-2" value={serialNumber} onChange={(event) => setSerialNumber(event.target.value)} /></label>
      <label className="text-xs font-bold text-slate-500">Inventory/Asset Number<input className="field mt-2" value={assetTag} onChange={(event) => setAssetTag(event.target.value)} required /></label>
      <label className="text-xs font-bold text-slate-500 sm:col-span-2">Update Sources<input className="field mt-2" value={updateSources} onChange={(event) => setUpdateSources(event.target.value)} placeholder="WSUS, vendor repository, or patch channel" /></label>
    </Section>
    <Section title="Operating System">
      <label className="text-xs font-bold text-slate-500">Name<input className="field mt-2" value={operatingSystem} onChange={(event) => setOperatingSystem(event.target.value)} /></label>
      <label className="text-xs font-bold text-slate-500">Architecture<input className="field mt-2" value={osArchitecture} onChange={(event) => setOsArchitecture(event.target.value)} placeholder="x86_64, arm64" /></label>
    </Section>
    <Section title="Management - Asset Lifecycle"><label className="text-xs font-bold text-slate-500">Date of Purchase<input className="field mt-2" type="date" value={purchaseDate} onChange={(event) => setPurchaseDate(event.target.value)} /></label></Section>
    <Section title="Financial & Administrative Information">
      <SearchableField label="Supplier" value={supplierName} options={suppliers} onChange={setSupplierName} />
      <label className="text-xs font-bold text-slate-500">Value <span className="font-semibold text-slate-400">({currency})</span><input className="field mt-2" type="number" min="0" step="0.01" value={cost} onChange={(event) => setCost(event.target.value)} /></label>
    </Section>
    <Section title="Warranty Information">
      <label className="text-xs font-bold text-slate-500">Warranty Start Date<input className="field mt-2" type="date" value={warrantyStartDate} onChange={(event) => setWarrantyStartDate(event.target.value)} /></label>
      <label className="text-xs font-bold text-slate-500">Warranty Duration (months)<input className="field mt-2" type="number" min="0" step="1" value={warrantyDuration} onChange={(event) => setWarrantyDuration(event.target.value)} /></label>
      <label className="text-xs font-bold text-slate-500">Warranty Expiry Date<input className="field mt-2 bg-slate-50 dark:bg-slate-800" type="date" value={warrantyExpiresAt} readOnly /></label>
    </Section>
    <label className="block text-xs font-bold text-slate-500">Specifications<textarea className="field mt-2 min-h-24 resize-y" value={specs} onChange={(event) => setSpecs(event.target.value)} /></label>
    {error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">{error}</p>}
    <div className="flex justify-end gap-2 border-t pt-4"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={saving || !branches.length}><PackagePlus size={17} />{saving ? 'Saving...' : device ? 'Save Changes' : 'Add Device'}</button></div>
  </form></Modal>
}