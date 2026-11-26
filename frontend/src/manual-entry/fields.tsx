import type { ReactNode } from 'react'
import { inputClass } from './api'

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block text-sm font-semibold text-slate-700 dark:text-slate-200">{label}{children}</label>
}
export function SelectField({ label, value, onChange, options, disabled, required }: {
  label: string; value: string; onChange: (value: string) => void; options: { id: string; name: string }[]; disabled?: boolean; required?: boolean
}) {
  return <Field label={label}><select className={inputClass} value={value} onChange={event => onChange(event.target.value)} disabled={disabled} required={required}><option value="">{required ? 'Select an option' : 'Not assigned'}</option>{options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></Field>
}
export function Feedback({ error, loading, retry }: { error: string; loading?: boolean; retry?: () => void }) {
  return <>{loading && <p role="status" className="text-sm text-slate-500">Loading records…</p>}{error && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">{error}{retry && <button type="button" className="secondary-button ml-3" onClick={retry}>Retry loading</button>}</div>}</>
}