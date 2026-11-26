import { useCallback, useState } from 'react'
import { ArrowUpRight, Building2, FileCode2, FileUp, FolderTree, Laptop, MapPin, MessageCircle, PackagePlus, ShieldCheck, Truck, UserPlus } from 'lucide-react'
import { useAuthToken } from '../lib/auth'
import { EmployeeForm } from './EmployeeForm'
import { EmployeeSearch } from './EmployeeSearch'
import { MasterSection, type MasterKind } from './MasterSection'
import type { SessionProps } from './api'
import { ApplicationsSection } from './ApplicationsSection'
import { GLPIImportSection } from './GLPIImportSection'
import { AccessoriesSection } from './AccessoriesSection'
import { BulkEmployeesSection } from './BulkEmployeesSection'
import { ChatAssignmentSection } from './ChatAssignmentSection'
import { WatchdogSection } from './WatchdogSection'

type Props = SessionProps & { verifiedAdministrator: boolean; employeeRoute?: boolean; applicationsRoute?: boolean; chatRoute?: boolean; watchdogRoute?: boolean; navigate: (path: string) => void }
type Section = 'hub' | 'watchdog' | 'employees' | 'bulk-employees' | 'applications' | 'chat' | 'glpi' | 'accessories' | MasterKind
const entries = [
  { section: 'bulk-employees' as const, title: 'Bulk employee accounts', description: 'New employee IDs, names and email addresses from CSV.', icon: UserPlus },
  { section: 'glpi' as const, title: 'Bulk asset', description: 'Computers, accessories and equipment.', icon: FileUp },
  { section: 'accessories' as const, title: 'Accessories & equipment', description: 'Asset register and manual stock.', icon: PackagePlus },
  { section: 'employees' as const, title: 'Employee addition / search', description: 'Create active employee accounts or find existing employees.', icon: UserPlus },
  { section: 'entities' as const, title: 'Entities', description: 'Add active entities with unique codes and full names.', icon: Building2 },
  { section: 'departments' as const, title: 'Departments', description: 'Add departments with entity-scoped names and codes.', icon: FolderTree },
  { section: 'locations' as const, title: 'Branches / Locations', description: 'Add entity locations, branch codes, city and state.', icon: MapPin },
]
const links = [
  { href: '/settings/watchdog', title: 'ITMS watchdog', description: 'Server checks, device reporting and operational errors.', icon: ShieldCheck },
  { href: '/settings/chat', title: 'Chat assignment', description: 'Issue rules and IT-team assignees.', icon: MessageCircle },
  { href: '/settings/applications', title: 'Applications', description: 'Approved packages by entity and operating system.', icon: PackagePlus },
  { href: '/admin/assets', title: 'Computers', description: 'Computer details, Financial & Administrative Information, Asset Lifecycle and Warranty.', icon: Laptop },
  { href: '/admin/suppliers', title: 'Suppliers', description: 'Open the existing supplier catalog and supplier entry forms.', icon: Truck },
  { href: '/admin/scripts', title: 'Installation scripts', description: 'Application and service installation scripts.', icon: FileCode2 },
  { href: '/devices', title: 'Manual stock in Devices', description: 'Open Devices → Manual stock → Add stock to use the existing stock form.', icon: PackagePlus },
]

export function ManualEntryPage(props: Props) {
  const account = useAuthToken()
  if (!props.verifiedAdministrator || !props.token || props.token !== account) return <p role="alert">Settings requires a verified admin or super_admin account.</p>
  return <ManualEntrySession key={`${props.token}:${!!props.employeeRoute}:${!!props.applicationsRoute}:${!!props.chatRoute}:${!!props.watchdogRoute}`} {...props} />
}

function ManualEntrySession({ token, onDenied, employeeRoute, applicationsRoute, chatRoute, watchdogRoute, navigate }: Props) {
  const [section, setSection] = useState<Section>(employeeRoute ? 'employees' : applicationsRoute ? 'applications' : chatRoute ? 'chat' : watchdogRoute ? 'watchdog' : 'hub')
  const [employeeMode, setEmployeeMode] = useState<'add' | 'search'>('add')
  const [revoked, setRevoked] = useState(false)
  const deny = useCallback(() => { setRevoked(true); onDenied() }, [onDenied])
  const props = { token, onDenied: deny }
  if (revoked) return <p role="alert">Access denied. Settings data has been cleared.</p>
  function open(next: Section) {
    if (next === 'employees') navigate('/settings/employees')
    else if (employeeRoute || applicationsRoute || chatRoute || watchdogRoute) navigate('/settings')
    setSection(next)
  }
  return <section className="page-enter mx-auto max-w-7xl space-y-6" aria-label="Settings">
    <div className="card flex flex-wrap items-center justify-between gap-4 bg-gradient-to-br from-blue-50 to-white p-6 dark:from-slate-900 dark:to-slate-950"><div><p className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-brand-600"><ShieldCheck size={17} />Administrator settings</p><h1 className="mt-2 text-3xl font-bold">Settings</h1><p className="mt-2 max-w-2xl text-sm text-slate-500">One place for employee and master-data entry, with direct access to existing asset, supplier, script and stock workflows.</p></div>{section !== 'hub' && <button className="secondary-button" onClick={() => open('hub')}>All settings</button>}</div>
    {section === 'watchdog' ? <WatchdogSection {...props} navigate={navigate} /> : section === 'hub' ? <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {entries.map(({ section: next, title, description, icon: Icon }) => <button key={next} onClick={() => open(next)} className="card group p-5 text-left transition hover:border-brand-500 hover:shadow-md"><Icon className="mb-4 text-brand-600" size={24} /><h2 className="font-bold">{title}</h2><p className="mt-2 text-sm text-slate-500">{description}</p><span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-brand-600">Open section <ArrowUpRight size={15} /></span></button>)}
      {links.map(({ href, title, description, icon: Icon }) => <a href={href} key={href} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); navigate(href) } }} className="card group p-5 transition hover:border-brand-500 hover:shadow-md"><Icon className="mb-4 text-brand-600" size={24} /><h2 className="font-bold">{title}</h2><p className="mt-2 text-sm text-slate-500">{description}</p><span className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-brand-600">Open existing workspace <ArrowUpRight size={15} /></span></a>)}
    </div> : section === 'chat' ? <ChatAssignmentSection {...props} /> : section === 'bulk-employees' ? <BulkEmployeesSection {...props} /> : section === 'accessories' ? <AccessoriesSection {...props} /> : section === 'glpi' ? <GLPIImportSection {...props} /> : section === 'applications' ? <ApplicationsSection token={token} /> : section === 'employees' ? <><div className="flex gap-2" role="group" aria-label="Employee actions"><button className={employeeMode === 'add' ? 'primary-button' : 'secondary-button'} aria-pressed={employeeMode === 'add'} onClick={() => setEmployeeMode('add')}>Add employee</button><button className={employeeMode === 'search' ? 'primary-button' : 'secondary-button'} aria-pressed={employeeMode === 'search'} onClick={() => setEmployeeMode('search')}>Search employees</button></div>{employeeMode === 'add' ? <EmployeeForm {...props} /> : <EmployeeSearch {...props} />}</> : <MasterSection key={section} kind={section} {...props} />}
  </section>
}