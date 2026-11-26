import type { Computer, ComputerPayload, Options } from './api'

export const sections = ['Computers', 'OS', 'Financial & Administrative Information', 'Management Asset Lifecycle', 'Warranty Information'] as const
type Field = { key: keyof ComputerPayload; label: string; section: typeof sections[number]; required?: boolean; max?: number; options?: keyof Options; kind?: 'date' | 'money' | 'months' | 'multiline' }
export const fields: Field[] = [
  { key: 'entityId', label: 'Entity', section: 'Computers', required: true, options: 'entities' },
  { key: 'name', label: 'Name', section: 'Computers', required: true, max: 150 },
  { key: 'assetTag', label: 'Asset number', section: 'Computers', required: true, max: 20 },
  { key: 'locationId', label: 'Location', section: 'Computers', options: 'locations' },
  { key: 'technicianInChargeId', label: 'Technician in charge', section: 'Management Asset Lifecycle', options: 'technicians' },
  { key: 'groupInChargeId', label: 'Group in charge', section: 'Management Asset Lifecycle', options: 'departments' },
  { key: 'deptId', label: 'Department', section: 'Management Asset Lifecycle', options: 'departments' },
  { key: 'assignedUserId', label: 'User', section: 'Management Asset Lifecycle', options: 'users' },
  { key: 'status', label: 'Status', section: 'Management Asset Lifecycle', required: true, max: 30 },
  { key: 'category', label: 'Type', section: 'Computers', required: true, max: 50 },
  { key: 'manufacturer', label: 'Manufacturer', section: 'Computers', max: 100 },
  { key: 'serialNumber', label: 'Serial number', section: 'Computers', max: 100 },
  { key: 'hostname', label: 'Hostname', section: 'Computers', max: 100 },
  { key: 'model', label: 'Model', section: 'Computers', max: 100 },
  { key: 'updateSources', label: 'Update sources', section: 'Computers', max: 4000, kind: 'multiline' },
  { key: 'notes', label: 'Notes', section: 'Management Asset Lifecycle', max: 10000, kind: 'multiline' },
  { key: 'osName', label: 'OS name', section: 'OS', max: 255 },
  { key: 'architecture', label: 'Architecture', section: 'OS', max: 100 },
  { key: 'purchaseDate', label: 'Purchase date', section: 'Financial & Administrative Information', kind: 'date' },
  { key: 'supplierId', label: 'Supplier', section: 'Financial & Administrative Information', options: 'suppliers' },
  { key: 'cost', label: 'Cost', section: 'Financial & Administrative Information', kind: 'money' },
  { key: 'warrantyStartDate', label: 'Warranty start date', section: 'Warranty Information', kind: 'date' },
  { key: 'warrantyDurationMonths', label: 'Warranty duration (months)', section: 'Warranty Information', kind: 'months' },
]
export type Draft = Record<keyof ComputerPayload, string>
export function toDraft(computer?: Computer): Draft {
  return Object.fromEntries(fields.map(({ key }) => [key, computer ? String(computer[key] ?? '') : key === 'status' ? 'in_use' : ''])) as Draft
}
export function changeEntity(draft: Draft, entityId: string): Draft {
  // Entity-owned IDs must not silently survive a transfer. Suppliers are global.
  return { ...draft, entityId, locationId: '', deptId: '', assignedUserId: '', technicianInChargeId: '', groupInChargeId: '' }
}
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year < 100 ? year + 400 : year, month, 0)).getUTCDate()
export function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
}
export function warrantyExpiry(start: string, duration: string): string | null {
  start = start.trim(); duration = duration.trim()
  if (!start || !duration) return null
  if (!validDate(start) || !/^\d+$/.test(duration) || Number(duration) > 1200) throw new Error('Enter a valid warranty date and an integer duration from 0 to 1200 months.')
  const [year, month, day] = start.split('-').map(Number)
  const offset = year * 12 + month - 1 + Number(duration)
  const endYear = Math.floor(offset / 12), endMonth = offset % 12 + 1
  if (endYear > 9999) throw new Error('Warranty expiry must not exceed year 9999.')
  return `${String(endYear).padStart(4, '0')}-${String(endMonth).padStart(2, '0')}-${String(Math.min(day, daysInMonth(endYear, endMonth))).padStart(2, '0')}`
}

export function buildPayload(draft: Draft, original?: Computer): ComputerPayload {
  const previous = toDraft(original)
  const entries: [string, string | number | null][] = []
  for (const field of fields) {
    // Legacy values may not satisfy today's normalization/validation rules.
    // Do not rewrite (or reject) a field the operator has not changed.
    if (original && draft[field.key] === previous[field.key]) continue
    const value = draft[field.key].trim()
    if (original && value === previous[field.key]) continue
    if (field.required && !value) throw new Error(`${field.label} is required.`)
    if (value.includes('\0') || (field.max && [...value].length > field.max)) throw new Error(`${field.label} is too long or contains invalid characters.`)
    if (value && field.options && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) throw new Error(`Select a valid ${field.label.toLowerCase()}.`)
    if (value && field.kind === 'date' && !validDate(value)) throw new Error(`${field.label} must be YYYY-MM-DD, years 0001–9999.`)
    if (value && field.kind === 'money' && !/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/.test(value)) throw new Error('Cost must be a nonnegative decimal with at most 10 integer and 2 fractional digits.')
    if (value && field.kind === 'months' && (!/^\d+$/.test(value) || Number(value) > 1200)) throw new Error('Warranty duration must be an integer from 0 to 1200 months.')
    if (value && field.key === 'hostname' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error('Hostname must use lowercase letters, numbers and hyphens.')
    entries.push([field.key, !value ? null : field.kind === 'months' ? Number(value) : value])
  }
  if (!original || draft.warrantyStartDate !== previous.warrantyStartDate || draft.warrantyDurationMonths !== previous.warrantyDurationMonths) warrantyExpiry(draft.warrantyStartDate, draft.warrantyDurationMonths)
  if (!entries.length) throw new Error('No changes to save.')
  return Object.fromEntries(entries) as ComputerPayload
}

export function validateOptions(payload: ComputerPayload, options: Options) {
  for (const field of fields) {
    const value = payload[field.key]
    // Unchanged legacy relationships are intentionally absent from PATCH.
    if (field.options && value && !options[field.options].some(option => option.id.toLowerCase() === String(value).toLowerCase())) {
      throw new Error(`Select an available ${field.label.toLowerCase()} for this entity.`)
    }
  }
}