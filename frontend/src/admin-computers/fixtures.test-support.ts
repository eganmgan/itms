import type { Computer, Options } from './api'
export const ids = {
  entity: '10000000-0000-0000-0000-000000000001', other: '10000000-0000-0000-0000-000000000002',
  asset: '20000000-0000-0000-0000-000000000001', location: '30000000-0000-0000-0000-000000000001',
  department: '40000000-0000-0000-0000-000000000001', user: '50000000-0000-0000-0000-000000000001',
  tech: '50000000-0000-0000-0000-000000000002', supplier: '60000000-0000-0000-0000-000000000001',
}
export const options: Options = {
  entities: [{ id: ids.entity, name: 'Primary entity' }, { id: ids.other, name: 'Other entity' }],
  locations: [{ id: ids.location, name: 'HQ' }], departments: [{ id: ids.department, name: 'IT department' }],
  users: [{ id: ids.user, name: 'Assigned person' }], technicians: [{ id: ids.tech, name: 'Technician person' }],
  suppliers: [{ id: ids.supplier, name: 'Global supplier' }],
}
export const computer: Computer = {
  id: ids.asset, isCompute: true, warrantyUntil: '2024-02-29', entityId: ids.entity, assetTag: 'PC-001', name: 'Manual workstation',
  category: 'workstation', status: 'in_use', hostname: 'manual-pc', manufacturer: 'Example', model: 'Model A', serialNumber: 'SER-001',
  locationId: ids.location, deptId: ids.department, assignedUserId: ids.user, technicianInChargeId: ids.tech,
  groupInChargeId: ids.department, supplierId: ids.supplier, purchaseDate: '2024-01-01', cost: '1234567890.12',
  warrantyStartDate: '2024-01-31', warrantyDurationMonths: 1, updateSources: 'Manual; vendor', osName: 'Linux', architecture: 'x86_64', notes: 'Initial note',
}
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}