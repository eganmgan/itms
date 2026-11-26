import { useEffect, useRef, useState, type FormEvent } from 'react'
import { getToken, subscribeAuth } from '../lib/auth'
import { inputClass, useManualResource, useManualWrite, type Department, type Entity, type Location, type SessionProps } from './api'
import { emptyEmployee, employeePayload } from './employeeModel'
import { Feedback, Field, SelectField } from './fields'

export function EmployeeForm(props: SessionProps) {
  const [draft, setDraft] = useState({ ...emptyEmployee })
  const [revision, refresh] = useState(0)
  const [notice, setNotice] = useState('')
  // The password lives only in the masked DOM control, never in React state,
  // storage, a URL, a success response, or a log. Clear on every sent request.
  const password = useRef<HTMLInputElement>(null)
  const entities = useManualResource<Entity[]>(props, '/entities', revision)
  const departments = useManualResource<Department[]>(props, draft.entity_id ? `/departments?entity_id=${encodeURIComponent(draft.entity_id)}` : null, revision)
  const locations = useManualResource<Location[]>(props, draft.entity_id ? `/locations?entity_id=${encodeURIComponent(draft.entity_id)}` : null, revision)
  const write = useManualWrite(props)
  useEffect(() => {
    const input = password.current
    const clear = () => { if (input) input.value = '' }
    const unsubscribe = subscribeAuth(() => { if (getToken() !== props.token) clear() })
    return () => { clear(); unsubscribe() }
  }, [props.token])
  const loading = entities.loading || departments.loading || locations.loading
  const loadError = entities.error || departments.error || locations.error
  function submit(event: FormEvent) {
    event.preventDefault(); write.setError(''); setNotice('')
    try {
      if (loading || loadError) throw new Error('Wait for entity options to load before saving.')
      const body = employeePayload(draft, password.current?.value ?? '', entities.data ?? [], departments.data ?? [], locations.data ?? [])
      if (password.current) password.current.value = ''
      void write.save('/users', body, () => { setDraft({ ...emptyEmployee }); setNotice('Employee created successfully. The initial password has been cleared.') })
    } catch (failure) { write.setError(failure instanceof Error ? failure.message : 'Check required fields.') }
  }
  return <form noValidate onSubmit={submit} aria-label="Add employee" className="card space-y-5 p-5 sm:p-6">
    <div><h2 className="text-xl font-bold">Add employee</h2><p className="mt-2 text-sm text-slate-500">Creates an active employee account only. Required fields are marked *. Department and location are optional.</p></div>
    <Feedback error={loadError} loading={loading} retry={() => refresh(value => value + 1)} />
    <Feedback error={write.error} />
    {notice && <p role="status" className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">{notice}</p>}
    <fieldset disabled={write.saving} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {([['full_name', 'Full name *', 100], ['emp_id', 'Employee ID *', 10], ['email', 'Email *', 150]] as const).map(([key, label, max]) => <Field key={key} label={label}><input className={inputClass} value={draft[key]} maxLength={max} type={key === 'email' ? 'email' : 'text'} required autoComplete="off" onChange={event => setDraft(current => ({ ...current, [key]: event.target.value }))} /></Field>)}
      <SelectField label="Entity *" required value={draft.entity_id} disabled={!entities.data} options={(entities.data ?? []).filter(item => item.is_active).map(item => ({ id: item.id, name: `${item.short_code} · ${item.full_name}` }))} onChange={entity_id => { setDraft(current => ({ ...current, entity_id, dept_id: '', location_id: '' })); setNotice('') }} />
      <SelectField label="Department" value={draft.dept_id} disabled={!departments.data} options={(departments.data ?? []).filter(item => item.entity_id === draft.entity_id)} onChange={dept_id => setDraft(current => ({ ...current, dept_id }))} />
      <SelectField label="Branch / Location" value={draft.location_id} disabled={!locations.data} options={(locations.data ?? []).filter(item => item.entity_id === draft.entity_id && item.is_active).map(item => ({ id: item.id, name: item.full_name }))} onChange={location_id => setDraft(current => ({ ...current, location_id }))} />
      <Field label="Initial password *"><input ref={password} className={inputClass} type="password" autoComplete="new-password" required maxLength={128} aria-describedby="employee-password-help" /></Field>
      <p id="employee-password-help" className="self-center text-xs text-slate-500 sm:col-span-2">Unique password or passphrase: 8–72 UTF-8 bytes, no leading or trailing whitespace. Uppercase, numbers and symbols are optional.</p>
      <div className="sm:col-span-2 lg:col-span-3"><button type="submit" className="primary-button" disabled={write.saving || loading || !!loadError}>{write.saving ? 'Creating employee…' : 'Create employee'}</button></div>
    </fieldset>
  </form>
}