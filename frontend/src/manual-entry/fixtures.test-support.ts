// Synthetic identities only; no sample password or deploy credentials.
export const ids = { entity: '10000000-0000-4000-8000-000000000001', other: '10000000-0000-4000-8000-000000000002', department: '20000000-0000-4000-8000-000000000001', location: '30000000-0000-4000-8000-000000000001' }
export const entities = [{ id: ids.entity, short_code: 'NORTH', full_name: 'North Example', is_active: true }, { id: ids.other, short_code: 'SOUTH', full_name: 'South Example', is_active: true }]
export const departments = [{ id: ids.department, entity_id: ids.entity, name: 'Engineering', short_code: 'eng' }]
export const locations = [{ id: ids.location, entity_id: ids.entity, full_name: 'North Office', location_code: 'N01', is_active: true }]
export const employee = { id: '40000000-0000-4000-8000-000000000001', full_name: 'Taylor Example', emp_id: 'EMP001', email: 'taylor@example.invalid', department: 'Engineering', location: 'North Office', status: 'active' }
export const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
export function api(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(String(input), 'http://localhost')
  if (init?.method === 'POST' || init?.method === 'PATCH') return Promise.resolve(json({ id: employee.id }, 201))
  if (url.pathname === '/api/auth/me') return Promise.resolve(json({ role: 'super_admin' }))
  if (url.pathname === '/api/entities') return Promise.resolve(json(entities))
  if (url.pathname === '/api/departments') return Promise.resolve(json(url.searchParams.get('entity_id') === ids.entity ? departments : []))
  if (url.pathname === '/api/locations') return Promise.resolve(json(url.searchParams.get('entity_id') === ids.entity ? locations : []))
  if (url.pathname === '/api/users') return Promise.resolve(json({ items: [employee], total: 26, page: Number(url.searchParams.get('page')), pageSize: 25 }))
  throw new Error(`Unexpected test endpoint ${url.pathname}`)
}