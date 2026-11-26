import { AdminCatalogPage } from '../admin-computers/AdminCatalogPage'
import type { CatalogProps } from '../admin-computers/catalog'
import { scriptConfig } from './config'

export function AdminScriptsPage(props: CatalogProps) { return <AdminCatalogPage {...props} config={scriptConfig} /> }