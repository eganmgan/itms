import { describe, expect, it } from 'vitest'
import { canManageComputers } from './api'
import { buildPayload, changeEntity, fields, toDraft, validDate, validateOptions, warrantyExpiry } from './model'
import { computer, ids, options } from './fixtures.test-support'

describe('manual computer contract', () => {
  it.each(['admin', 'super_admin'])('allows only literal %s', role => expect(canManageComputers(role)).toBe(true))
  it.each(['it_team', 'employee', 'auditor', 'administrator', 'ADMIN', ' admin', null, undefined, { role: 'admin' }])('denies nonliteral role %j', role => expect(canManageComputers(role)).toBe(false))
  it('sends all writable create fields, exact decimal string and integer duration, never server-owned keys', () => {
    const { id: _id, isCompute: _compute, warrantyUntil: _expiry, ...expected } = computer
    expect(buildPayload(toDraft(computer))).toEqual(expected)
  })
  it('patches only changed fields and uses explicit null for cleared fields', () => {
    expect(buildPayload({ ...toDraft(computer), name: 'Changed', cost: '', assignedUserId: '', warrantyDurationMonths: '0' }, computer)).toEqual({ name: 'Changed', cost: null, assignedUserId: null, warrantyDurationMonths: 0 })
    expect(() => buildPayload(toDraft(computer), computer)).toThrow('No changes')
  })
  it('clears every entity-owned relationship on transfer but preserves global supplier', () => {
    expect(buildPayload(changeEntity(toDraft(computer), ids.other), computer)).toEqual({ entityId: ids.other, locationId: null, deptId: null, groupInChargeId: null, assignedUserId: null, technicianInChargeId: null })
  })
  it.each(['-1', '1e3', '1.234', '10000000000', '01', '.5'])('rejects invalid money %s', cost => expect(() => buildPayload({ ...toDraft(computer), cost })).toThrow('Cost'))
  it.each(['-1', '1.5', '1201', '1e2'])('rejects invalid duration %s', warrantyDurationMonths => expect(() => buildPayload({ ...toDraft(computer), warrantyDurationMonths })).toThrow('duration'))
  it.each(['2023-02-29', '2024-04-31', '0000-01-01', '10000-01-01', '2024-1-01', 'not a date'])('rejects invalid date %s', purchaseDate => expect(() => buildPayload({ ...toDraft(computer), purchaseDate })).toThrow('Purchase date'))
  it('validates required labels, identifiers, hostname and length limits', () => {
    expect(() => buildPayload({ ...toDraft(computer), category: '' })).toThrow('Type is required')
    expect(() => buildPayload({ ...toDraft(computer), locationId: 'HQ' })).toThrow('valid location')
    expect(() => buildPayload({ ...toDraft(computer), hostname: 'INVALID_HOST' })).toThrow('Hostname')
    expect(() => buildPayload({ ...toDraft(computer), assetTag: 'a'.repeat(21) })).toThrow('too long')
  })
  it('clamps warranty month ends, supports zero months and early years, rejects overflow', () => {
    expect(warrantyExpiry('2024-01-31', '1')).toBe('2024-02-29')
    expect(warrantyExpiry('2023-01-31', '1')).toBe('2023-02-28')
    expect(warrantyExpiry('0001-01-31', '1')).toBe('0001-02-28')
    expect(validDate('0004-02-29')).toBe(true)
    expect(warrantyExpiry('2024-01-31', '0')).toBe('2024-01-31')
    expect(warrantyExpiry('2024-01-31', '')).toBeNull()
    expect(warrantyExpiry(' 2024-01-31 ', ' 1 ')).toBe('2024-02-29')
    expect(warrantyExpiry('2024-01-31', ' ')).toBeNull()
    expect(() => warrantyExpiry('9999-12-01', '1')).toThrow('9999')
  })
  it('does not recalculate or send a legacy warranty on unrelated edits', () => {
    const legacy = { ...computer, warrantyStartDate: null, warrantyDurationMonths: null, warrantyUntil: '2030-01-01' }
    expect(buildPayload({ ...toDraft(legacy), notes: 'Changed' }, legacy)).toEqual({ notes: 'Changed' })
  })
  it('preserves untouched legacy whitespace and invalid hostnames on sparse edits', () => {
    const legacy = { ...computer, notes: '  Original note\n', manufacturer: ' Vendor ', hostname: 'OLD_HOST' }
    expect(buildPayload({ ...toDraft(legacy), name: 'Renamed' }, legacy)).toEqual({ name: 'Renamed' })
    expect(() => buildPayload(toDraft(legacy), legacy)).toThrow('No changes')
    expect(buildPayload({ ...toDraft(legacy), notes: '' }, legacy)).toEqual({ notes: null })
  })
  it.each(fields.filter(field => !field.required).map(field => field.key))('clears optional %s with explicit null only', key => {
    expect(buildPayload({ ...toDraft(computer), [key]: '' }, computer)).toEqual({ [key]: null })
  })
  it('validates only changed relationship IDs against scoped options', () => {
    expect(() => validateOptions({ name: 'Renamed', locationId: null }, { ...options, locations: [] })).not.toThrow()
    expect(() => validateOptions({ locationId: ids.location }, { ...options, locations: [] })).toThrow('available location')
    expect(() => validateOptions({ assignedUserId: ids.tech }, options)).toThrow('available user')
    expect(() => validateOptions(buildPayload(toDraft(computer)), options)).not.toThrow()
  })
})