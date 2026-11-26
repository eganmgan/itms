import { useState } from 'react'
import { inputClass, useManualResource, type EmployeeList, type SessionProps } from './api'
import { Feedback, Field } from './fields'

export function EmployeeSearch(props: SessionProps) {
  const [draft, setDraft] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [revision, refresh] = useState(0)
  const params = new URLSearchParams({ page: String(page), page_size: '25', role: 'employee' })
  if (search) params.set('search', search)
  const list = useManualResource<EmployeeList>(props, `/users?${params}`, revision)
  return <section className="card space-y-5 p-5 sm:p-6" aria-label="Search employees">
    <div><h2 className="text-xl font-bold">Search employees</h2><p className="mt-2 text-sm text-slate-500">Search saved employee accounts by name, employee ID or email across server-side pages.</p></div>
    <form onSubmit={event => { event.preventDefault(); setSearch(draft.trim()); setPage(1); refresh(value => value + 1) }} className="flex flex-wrap items-end gap-3"><div className="min-w-64 flex-1"><Field label="Employee search"><input type="search" className={inputClass} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Name, employee ID or email" /></Field></div><button className="primary-button" type="submit">Search</button></form>
    <Feedback error={list.error} loading={list.loading} retry={() => refresh(value => value + 1)} />
    {list.data && <><div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Employee search results</caption><thead><tr>{['Name', 'Employee ID', 'Email', 'Department', 'Location', 'Status', 'Account'].map(label => <th scope="col" className="p-3" key={label}>{label}</th>)}</tr></thead><tbody>{list.data.items.map(item => <tr className="border-t" key={item.id}>{[item.full_name, item.emp_id, item.email, item.department, item.location, item.status].map((value, index) => <td key={index} className="p-3">{value || 'Not assigned'}</td>)}<td className="p-3"><a className="font-semibold text-brand-600" href={`/employee/users/${encodeURIComponent(item.id)}`}>Password &amp; access</a></td></tr>)}</tbody></table>{!list.data.items.length && <p className="p-4 text-sm text-slate-500">No employees found.</p>}</div><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm" role="status">Page {list.data.page} · {list.data.total} employees</p><div className="flex gap-2"><button className="secondary-button" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button><button className="secondary-button" disabled={list.data.page * list.data.pageSize >= list.data.total} onClick={() => setPage(value => value + 1)}>Next</button></div></div></>}
  </section>
}