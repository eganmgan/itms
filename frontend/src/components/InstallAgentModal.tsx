import { useMemo, useState } from 'react'
import { Apple, Check, CheckCircle2, ChevronDown, Clipboard, Monitor, ServerCog, ShieldCheck, TerminalSquare } from 'lucide-react'
import type { DirectoryGroup, DirectoryUser } from '../pages/DevicesPage'
import { Modal } from './ui'

type AgentOS = 'windows' | 'linux' | 'fedora' | 'macos'

interface InstallAgentModalProps {
  departments: DirectoryGroup[]
  users: DirectoryUser[]
  onClose: () => void
}

interface InstallCommandResponse {
  command: string
  os: AgentOS
  user: { fullName: string; email: string; employeeCode: string; departmentName: string }
}

interface UserListResponse {
  items: Array<{ id: string; full_name: string; email: string; emp_id: string; dept_id?: string; department?: string }>
}

const operatingSystems = [
  { id: 'windows' as const, label: 'Windows', detail: 'Salt, Wazuh and inventory', icon: Monitor },
  { id: 'linux' as const, label: 'Ubuntu / Debian', detail: 'Full security stack', icon: TerminalSquare },
  { id: 'fedora' as const, label: 'Fedora / RHEL', detail: 'RPM security stack', icon: TerminalSquare },
  { id: 'macos' as const, label: 'macOS', detail: 'Native endpoint stack', icon: Apple },
]

function SelectMenu({ label, value, options, placeholder, loading = false, disabled = false, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; placeholder: string; loading?: boolean; disabled?: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false)
  const selected = options.find((option) => option.value === value)

  return <div className="relative"><span className="text-[11px] font-bold text-slate-600 dark:text-slate-300">{label}</span><button type="button" role="combobox" aria-label={label} aria-expanded={open} aria-controls={`${label.toLowerCase().replaceAll(' ', '-')}-options`} disabled={disabled || loading} className="field mt-2 flex items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60" onPointerDown={(event) => event.stopPropagation()} onClick={() => setOpen((current) => !current)}><span className="truncate">{loading ? 'Loading employees...' : selected?.label || placeholder}</span><ChevronDown size={15} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} /></button>{open && <div id={`${label.toLowerCase().replaceAll(' ', '-')}-options`} role="listbox" aria-label={`${label} options`} className="absolute bottom-full z-50 mb-1 max-h-52 w-full overflow-y-auto rounded-md border bg-white p-1 shadow-xl dark:bg-slate-900" onPointerDown={(event) => event.stopPropagation()}>{options.length ? options.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === value} className={`flex w-full items-center justify-between gap-2 rounded px-3 py-2 text-left text-xs ${option.value === value ? 'bg-blue-50 font-bold text-brand-600 dark:bg-blue-950/40' : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800'}`} onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); onChange(option.value); setOpen(false) }} onClick={() => { onChange(option.value); setOpen(false) }}><span>{option.label}</span>{option.value === value && <Check size={14} />}</button>) : <p className="px-3 py-2 text-xs text-slate-500">No options available</p>}</div>}</div>
}

export function InstallAgentModal({ departments, users, onClose }: InstallAgentModalProps) {
  const [os, setOS] = useState<AgentOS>('windows')
  const [departmentId, setDepartmentId] = useState('')
  const [userId, setUserId] = useState('')
  const [result, setResult] = useState<InstallCommandResponse | null>(null)
  const [error, setError] = useState('')
  const [generating, setGenerating] = useState(false)
  const [loadingEmployees, setLoadingEmployees] = useState(false)
  const [copied, setCopied] = useState(false)
  const [availableUsers, setAvailableUsers] = useState(users)

  const departmentUsers = useMemo(
    () => {
      const selectedDepartment = departments.find((department) => department.id === departmentId)
      return selectedDepartment
        ? availableUsers.filter((user) => user.departmentId === selectedDepartment.id || user.departmentName === selectedDepartment.name)
        : []
    },
    [availableUsers, departmentId, departments],
  )

  function selectOS(nextOS: AgentOS) {
    setOS(nextOS)
    setResult(null)
    setError('')
  }

  async function selectDepartment(nextDepartmentId: string) {
    const selectedDepartment = departments.find((department) => department.id === nextDepartmentId)
    const matches = selectedDepartment
      ? users.filter((user) => user.departmentId === selectedDepartment.id || user.departmentName === selectedDepartment.name)
      : []
    setDepartmentId(nextDepartmentId)
    setUserId(matches[0]?.id ?? '')
    setResult(null)
    setError('')
    if (!selectedDepartment) return

    const token = localStorage.getItem('itms_token')
    if (!token) return
    setLoadingEmployees(true)
    try {
      const response = await fetch(`/api/users?dept=${encodeURIComponent(nextDepartmentId)}&status=active&paginate=1&page_size=200`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!response.ok) throw new Error('Could not load employees for this department.')
      const payload = await response.json() as UserListResponse
      const fetchedUsers: DirectoryUser[] = payload.items.map((user) => ({
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        employeeCode: user.emp_id,
        departmentId: user.dept_id || nextDepartmentId,
        departmentName: user.department || selectedDepartment.name,
        branchName: '',
        assetCount: 0,
        newAssetCount: 0,
        ungroupedAssetCount: 0,
        flaggedAssetCount: 0,
        status: 'unassigned',
      }))
      setAvailableUsers((current) => [...current.filter((user) => user.departmentId !== nextDepartmentId && user.departmentName !== selectedDepartment.name), ...fetchedUsers])
      setUserId(fetchedUsers[0]?.id ?? '')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load employees for this department.')
    } finally {
      setLoadingEmployees(false)
    }
  }

  async function generateCommand() {
    const token = localStorage.getItem('itms_token')
    if (!token || !departmentId || !userId) return
    setGenerating(true)
    setError('')
    setResult(null)
    try {
      const response = await fetch('/api/devices/install-command', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, os }),
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(payload.error || (response.status === 403 ? 'You do not have permission to install agents.' : 'Could not generate the installation command.'))
      }
      setResult(await response.json() as InstallCommandResponse)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not generate the installation command.')
    } finally {
      setGenerating(false)
    }
  }

  async function copyCommand() {
    if (!result) return
    setError('')
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(result.command)
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = result.command
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      const copiedWithFallback = document.execCommand('copy')
      textarea.remove()
      if (!copiedWithFallback) {
        setError('Copy failed. Select the command text and copy it manually.')
        return
      }
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const linuxComponents = ['Salt minion', 'Passwordless SSH key', 'OpenSCAP', 'Wazuh agent', 'ClamAV', 'Trivy CVE scanner']
  const windowsComponents = ['Salt minion', 'Wazuh agent', 'ClamWin', 'Inventory collector']
  const macOSComponents = ['Salt minion', 'Remote Login SSH key', 'Wazuh agent', 'ClamAV', 'Trivy CVE scanner', 'Inventory collector']
  const components = os === 'windows' ? windowsComponents : os === 'macos' ? macOSComponents : linuxComponents
  const runInstruction = os === 'windows' ? 'PowerShell as Administrator' : os === 'macos' ? 'Terminal as an administrator' : 'a terminal with sudo'

  return <Modal title="Install new monitoring agent" size="h-[calc(100dvh-1rem)] max-w-none sm:h-[calc(100dvh-2rem)]" onClose={onClose}>
    <div className="space-y-5 p-5 sm:p-6">
      <p className="text-xs leading-5 text-slate-500">Select the endpoint operating system, department, and employee. ITMS generates one secure command; the installer detects hardware and network details automatically.</p>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-4">
          <fieldset>
            <legend className="mb-2 text-[11px] font-bold text-slate-600 dark:text-slate-300">Operating system</legend>
            <div className="grid gap-2">
              {operatingSystems.map(({ id, label, detail, icon: Icon }) => <button key={id} type="button" onClick={() => selectOS(id)} className={`flex min-h-16 items-center gap-3 rounded-md border px-3 text-left ${os === id ? 'border-blue-600 bg-blue-50 text-blue-700 ring-1 ring-blue-600 dark:bg-blue-950/30 dark:text-blue-300' : 'border-slate-200 dark:border-slate-700'}`}><span className={`flex h-9 w-9 items-center justify-center rounded-md ${os === id ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-slate-800'}`}><Icon size={18} /></span><span><strong className="block text-xs">{label}</strong><small className="text-[10px] text-slate-500">{detail}</small></span></button>)}
            </div>
          </fieldset>

          <SelectMenu label="Department" value={departmentId} options={departments.map((item) => ({ value: item.id, label: item.name }))} placeholder="Select department" onChange={(value) => void selectDepartment(value)} />

          <SelectMenu label="Employee name" value={userId} options={departmentUsers.map((user) => ({ value: user.id, label: `${user.fullName} · ${user.employeeCode}` }))} placeholder={departmentId ? 'Select employee' : 'Select department first'} loading={loadingEmployees} disabled={!departmentId || departmentUsers.length === 0} onChange={(value) => { setUserId(value); setResult(null) }} />
        </aside>

        <section className="min-w-0 space-y-4">
          <div className="rounded-md border border-slate-200 p-4 dark:border-slate-700"><div className="flex items-center gap-2"><ShieldCheck size={17} className="text-emerald-600" /><strong className="text-xs">Components included</strong></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{components.map((item) => <span key={item} className="flex items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300"><CheckCircle2 size={14} className="text-emerald-600" />{item}</span>)}</div>{os === 'windows' && <p className="mt-3 text-[10px] leading-4 text-amber-700 dark:text-amber-300">Passwordless SSH, OpenSCAP, and Trivy root-filesystem CVE scanning are available on Linux endpoints. Windows uses Wazuh vulnerability detection and the approved Windows compliance scanner.</p>}{os === 'macos' && <p className="mt-3 text-[10px] leading-4 text-amber-700 dark:text-amber-300">OpenSCAP does not provide supported macOS content. The macOS installer uses Wazuh security configuration assessment and Trivy vulnerability scanning instead.</p>}</div>

          <div className="min-w-0"><div className="mb-2 flex items-center justify-between gap-3"><p className="text-[11px] font-bold text-slate-600 dark:text-slate-300">Run {runInstruction}:</p>{result && <button type="button" className="secondary-button !h-8 !px-3" onClick={() => void copyCommand()}><Clipboard size={14} />{copied ? 'Copied' : 'Copy command'}</button>}</div><div className="min-h-44 max-w-full overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-[#062653] p-4 font-mono text-[11px] leading-5 text-blue-50">{result?.command ?? <span className="text-blue-200">Select OS, department, and employee, then generate the command.</span>}</div></div>

          {error && <p className="rounded-md bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 dark:bg-rose-950/30 dark:text-rose-300">{error}</p>}
          <div className="flex justify-end gap-2"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={generating || !departmentId || !userId} onClick={() => void generateCommand()}><ServerCog size={16} />{generating ? 'Generating...' : result ? 'Regenerate command' : 'Generate command'}</button></div>
        </section>
      </div>
    </div>
  </Modal>
}
