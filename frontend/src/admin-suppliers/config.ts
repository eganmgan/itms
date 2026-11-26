import type { CatalogConfig } from '../admin-computers/catalog'

export const supplierConfig: CatalogConfig = {
  path: '/admin/suppliers', title: 'Supplier administration', singular: 'supplier',
  notice: 'Suppliers are shared global records. Admin and legacy super_admin accounts can view, add, and edit them. Contact information is business contact data, not credentials.',
  fields: [{ key: 'name', label: 'Supplier name', max: 150, required: true }, { key: 'contactInfo', label: 'Contact information', max: 4000, multiline: true }],
}