import { useEffect, useState } from 'react'
import { AdminCatalogPage } from '../admin-computers/AdminCatalogPage'
import type { CatalogProps, CatalogRecord } from '../admin-computers/catalog'
import { accessFailure, useAdminResource } from '../admin-computers/api'
import { supplierConfig } from './config'

export function AdminSuppliersPage(props: CatalogProps) { return <AdminCatalogPage {...props} config={supplierConfig} /> }

export function SupplierDetails({ id, token, onDenied }: CatalogProps & { id: string | null }) {
  const [open, setOpen] = useState(false)
  const [revision, setRevision] = useState(0)
  const detail = useAdminResource<CatalogRecord>(token, open && id ? `/admin/suppliers/${encodeURIComponent(id)}` : null, revision)
  const denied = accessFailure(detail.error)
  useEffect(() => { if (denied) onDenied() }, [denied, onDenied])
  return <div className="mt-4 space-y-3 border-t pt-4">
    <div className="flex flex-wrap gap-3">{id && <button type="button" className="secondary-button" onClick={() => setOpen(value => !value)}>{open ? 'Hide supplier details' : 'View supplier details'}</button>}<a className="secondary-button" href="/admin/suppliers">Supplier directory &amp; administration</a></div>
    {open && <section aria-label="Supplier details">{denied ? <p role="alert">Access denied.</p> : detail.error ? <div role="alert">{detail.error.message}<button type="button" className="secondary-button ml-3" onClick={() => setRevision(value => value + 1)}>Retry supplier</button></div> : detail.loading ? <p role="status">Loading supplier…</p> : detail.data && <dl><dt className="font-semibold">Supplier name</dt><dd>{detail.data.name}</dd><dt className="mt-2 font-semibold">Contact information</dt><dd className="whitespace-pre-wrap break-words">{detail.data.contactInfo || 'Not recorded'}</dd></dl>}</section>}
  </div>
}