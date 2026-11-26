import { describe, expect, it } from 'vitest'
import { employeePayload } from './employeeModel'
import { departments, entities, ids, locations } from './fixtures.test-support'

const draft = { full_name: 'Taylor Example', emp_id: 'EMP001', email: 'taylor@example.invalid', entity_id: ids.entity, dept_id: ids.department, location_id: ids.location }
const password = () => `Aa!${crypto.randomUUID()}`
describe('employee payload relationship validation', () => {
  it('accepts custom passphrases but enforces the bcrypt byte limit', () => {
    expect(employeePayload(draft, 'several ordinary words', entities, departments, locations).initial_password).toBe('several ordinary words')
    expect(() => employeePayload(draft, 'a'.repeat(73), entities, departments, locations)).toThrow('8–72 UTF-8 bytes')
  })
  it('rejects foreign department and inactive or foreign location even if options contain them', () => {
    expect(() => employeePayload(draft, password(), entities, [{ ...departments[0], entity_id: ids.other }], locations)).toThrow('department in this entity')
    expect(() => employeePayload(draft, password(), entities, departments, [{ ...locations[0], entity_id: ids.other }])).toThrow('active location in this entity')
    expect(() => employeePayload(draft, password(), entities, departments, [{ ...locations[0], is_active: false }])).toThrow('active location in this entity')
  })
  it('rejects unavailable entity and preserves optional blank relationships', () => {
    expect(() => employeePayload(draft, password(), [], departments, locations)).toThrow('active entity')
    expect(employeePayload({ ...draft, dept_id: '', location_id: '' }, password(), entities, [], [])).toMatchObject({ dept_id: '', location_id: '', role: 'employee', is_active: true })
  })
  it('never trims password or includes it in validation errors', () => {
    const secret = ` ${password()} `
    expect(() => employeePayload(draft, secret, entities, departments, locations)).toThrow('no leading or trailing whitespace')
    try { employeePayload(draft, secret, entities, departments, locations) } catch (error) { expect(String(error)).not.toContain(secret) }
  })
})