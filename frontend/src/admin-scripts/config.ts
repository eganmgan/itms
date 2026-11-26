import type { CatalogConfig } from '../admin-computers/catalog'

export const scriptConfig: CatalogConfig = {
  path: '/admin/scripts', title: 'Application & service installation scripts', singular: 'installation script', scoped: false,
  notice: 'Saving does not execute a script. Application and service scripts are available in Apps & Services for compatible Linux devices. Applying a reviewed version requires admin confirmation.',
  fields: [
    { key: 'category', label: 'Category', max: 20, required: true, choices: ['application', 'service'] },
    { key: 'name', label: 'Name / application', max: 150, required: true },
    { key: 'type', label: 'Language / type', max: 10, required: true, choices: ['sh'] },
    { key: 'os', label: 'Platform', max: 30, required: true, choices: ['default', 'Ubuntu', 'Debian', 'Rocky Linux'] },
    { key: 'body', label: 'Script body', max: 48000, required: true, multiline: true },
    { key: 'description', label: 'Description', max: 4000, multiline: true },
  ],
}