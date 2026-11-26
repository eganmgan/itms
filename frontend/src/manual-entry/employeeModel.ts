import type { Department, Entity, Location } from './api'

export const emptyEmployee = { full_name: '', emp_id: '', email: '', entity_id: '', dept_id: '', location_id: '' }
export type EmployeeDraft = typeof emptyEmployee

export function employeePayload(draft: EmployeeDraft, password: string, entities: Entity[], departments: Department[], locations: Location[]) {
  const values = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.trim()])) as EmployeeDraft
  for (const [key, label, max] of [['full_name', 'Full name', 100], ['emp_id', 'Employee ID', 10], ['email', 'Email', 150]] as const) {
    if (!values[key]) throw new Error(`${label} is required.`)
    if ([...values[key]].length > max || [...values[key]].some(character => character.charCodeAt(0) < 32)) throw new Error(`${label} is too long or contains invalid characters.`)
  }
  values.email = values.email.toLowerCase()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(values.emp_id)) throw new Error('Employee ID must start with a letter or number and contain only letters, numbers, dot, underscore or hyphen.')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) throw new Error('Enter a valid email address.')
  if (!entities.some(entity => entity.id === values.entity_id && entity.is_active)) throw new Error('Select an active entity.')
  if (values.dept_id && !departments.some(item => item.id === values.dept_id && item.entity_id === values.entity_id)) throw new Error('Select a department in this entity.')
  if (values.location_id && !locations.some(item => item.id === values.location_id && item.entity_id === values.entity_id && item.is_active)) throw new Error('Select an active location in this entity.')
  if (!password) throw new Error('Initial password is required.')
  const bytes = new TextEncoder().encode(password).length
  if (/^\p{White_Space}|\p{White_Space}$/u.test(password) || bytes < 8 || bytes > 72) throw new Error('Initial password must be 8–72 UTF-8 bytes with no leading or trailing whitespace.')
  return { ...values, initial_password: password, role: 'employee' as const, is_active: true as const }
}