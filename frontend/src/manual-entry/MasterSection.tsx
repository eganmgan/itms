import { useState, type FormEvent } from 'react'
import { inputClass, useManualResource, useManualWrite, type Department, type Entity, type Location, type SessionProps } from './api'
import { Feedback, Field, SelectField } from './fields'

export type MasterKind = 'entities' | 'departments' | 'locations'
const names = { entities: 'Entities', departments: 'Departments', locations: 'Branches / Locations' }
const empty = { name: '', code: '', description: '', city: '', state: '' }

export function MasterSection({ kind, ...props }: SessionProps & { kind: MasterKind }) {
  const [entityId, setEntity] = useState('')
  const [draft, setDraft] = useState({ ...empty })
  const [revision, refresh] = useState(0)
  const [notice, setNotice] = useState('')
  const entities = useManualResource<Entity[]>(props, '/entities', revision)
  const list = useManualResource<(Department | Location)[]>(props, kind !== 'entities' && entityId ? `/${kind}?entity_id=${encodeURIComponent(entityId)}` : null, revision)
  const write = useManualWrite(props)
  const entity = entities.data?.find(item => item.id === entityId)
  const loading = entities.loading || list.loading
  const loadError = entities.error || list.error
  const selectEntity = (id: string) => {
    setEntity(id); setNotice(''); write.setError('')
    setDraft({ ...empty })
  }
  function submit(event: FormEvent) {
    event.preventDefault(); setNotice(''); write.setError('')
    try {
      if (kind !== 'entities' && (!entity || !entity.is_active)) throw new Error('Select an available entity.')
      if (loading || loadError) throw new Error('Wait for records to load before saving.')
      const name = draft.name.trim(), code = draft.code.trim()
      if (!name) throw new Error('Name is required.')
      if (!code) throw new Error('Code is required.')
      if ([...name].length > (kind === 'departments' ? 100 : 150)) throw new Error('Name is too long.')
      const codeMax = kind === 'entities' ? 10 : kind === 'departments' ? 20 : 30
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(code) || code.length > codeMax) throw new Error(`Code must start with a letter or number and contain at most ${codeMax} letters, numbers, dots, hyphens or underscores.`)
      if ([draft.city, draft.state].some(value => [...value.trim()].length > 80)) throw new Error('City and state must be at most 80 characters.')
      const body = kind === 'entities' ? { full_name: name, short_code: code.toUpperCase(), is_active: true }
        : kind === 'departments' ? { entity_id: entityId, name, short_code: code.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+$/g, '').replace(/-+/g, '-'), description: draft.description.trim() }
          : { entity_id: entityId, full_name: name, location_code: code.toUpperCase(), city: draft.city.trim(), state: draft.state.trim(), is_active: true }
      void write.save(`/${kind}`, body, () => {
        setNotice('Record created successfully.')
        setDraft({ ...empty })
        refresh(value => value + 1)
      })
    } catch (failure) { write.setError(failure instanceof Error ? failure.message : 'Check required fields.') }
  }
  return <section className="card space-y-5 p-5 sm:p-6" aria-label={names[kind]}>
    <div><h2 className="text-xl font-bold">{names[kind]}</h2><p className="mt-2 text-sm text-slate-500">{kind === 'entities' ? 'Add an active entity with a unique code and full name. Required fields are marked *.' : 'Create a record in the selected entity. Changing the entity clears the form.'}</p></div>
    <Feedback loading={loading} error={loadError} retry={() => refresh(value => value + 1)} />
    {notice && <p role="status" className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">{notice}</p>}
    <form noValidate onSubmit={submit} aria-label={`Create ${kind === 'entities' ? 'entity' : kind === 'departments' ? 'department' : 'location'}`} className="space-y-4">
      <Feedback error={write.error} />
      <fieldset disabled={write.saving} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {kind !== 'entities' && <SelectField label="Entity *" required value={entityId} onChange={selectEntity} disabled={!entities.data} options={(entities.data ?? []).filter(item => item.is_active).map(item => ({ id: item.id, name: `${item.short_code} · ${item.full_name}` }))} />}
        <Field label="Name *"><input className={inputClass} required value={draft.name} maxLength={kind === 'departments' ? 100 : 150} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} /></Field>
        <Field label="Code *"><input className={inputClass} required value={draft.code} maxLength={kind === 'entities' ? 10 : kind === 'departments' ? 20 : 30} onChange={event => setDraft(current => ({ ...current, code: event.target.value }))} /></Field>
        {kind === 'departments' && <Field label="Description"><textarea className={inputClass} maxLength={4000} value={draft.description} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} /></Field>}
        {kind === 'locations' && (['city', 'state'] as const).map(key => <Field key={key} label={key === 'city' ? 'City' : 'State'}><input className={inputClass} maxLength={80} value={draft[key]} onChange={event => setDraft(current => ({ ...current, [key]: event.target.value }))} /></Field>)}
        <div className="sm:col-span-2 lg:col-span-3"><button type="submit" className="primary-button" disabled={write.saving || loading || !!loadError}>{write.saving ? 'Saving…' : kind === 'entities' ? 'Create entity' : kind === 'departments' ? 'Create department' : 'Create location'}</button></div>
      </fieldset>
    </form>
    <div className="border-t pt-4"><h3 className="font-bold">Existing {names[kind].toLowerCase()}</h3>{kind === 'entities' ? <ul className="mt-3 grid gap-2 sm:grid-cols-2">{entities.data?.map(item => <li key={item.id} className="rounded-xl border p-3 text-sm">{item.short_code} · {item.full_name}{!item.is_active && ' · Inactive'}</li>)}</ul> : !entityId ? <p className="mt-2 text-sm text-slate-500">Select an entity to load its records.</p> : list.data && <ul className="mt-3 grid gap-2 sm:grid-cols-2">{list.data.filter(item => item.entity_id === entityId).map(item => <li className="rounded-xl border p-3 text-sm" key={item.id}>{'name' in item ? `${item.short_code} · ${item.name}` : `${item.location_code} · ${item.full_name}`}</li>)}</ul>}{(kind === 'entities' ? entities.data : list.data)?.length === 0 && <p className="mt-3 text-sm text-slate-500">No records found.</p>}</div>
  </section>
}