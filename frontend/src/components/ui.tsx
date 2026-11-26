import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ClipboardCheck, LayoutDashboard, ScrollText, X } from 'lucide-react'
import type { Tone } from '../types'

const tones: Record<Tone, string> = {
  blue: 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
  green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  amber: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  rose: 'bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
  slate: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  indigo: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300',
}

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[10px] font-extrabold ${tones[tone]}`}>{children}</span>
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="text-[10px] font-bold uppercase tracking-widest text-brand-600">{eyebrow}</p><h1 className="mt-1 text-2xl font-black tracking-tight">{title}</h1><p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{description}</p></div>{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}</div>
}

export function Tabs({ tabs, active, onChange }: { tabs: string[]; active: string; onChange: (tab: string) => void }) {
  return <div className="flex gap-2 overflow-x-auto p-1.5" role="tablist">{tabs.map((tab) => <button role="tab" aria-selected={active === tab} key={tab} onClick={() => onChange(tab)} className={`shrink-0 rounded-xl px-4 py-2 text-xs font-bold transition ${active === tab ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-white'}`}>{tab}</button>)}</div>
}

export function Modal({ title, children, onClose, size = 'max-w-2xl' }: { title: string; children: ReactNode; onClose: () => void; size?: string }) {
  return createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 p-2 backdrop-blur-sm sm:p-4" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><div className={`flex max-h-[96vh] w-full flex-col overflow-hidden rounded-lg border bg-white shadow-2xl sm:max-h-[92vh] dark:bg-slate-900 ${size}`} onMouseDown={(event) => event.stopPropagation()}><div className="flex shrink-0 items-center justify-between gap-4 border-b bg-white px-4 py-3 sm:px-6 sm:py-4 dark:bg-slate-900"><h2 className="min-w-0 text-sm font-bold sm:text-base">{title}</h2><button className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 shadow-sm transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:hover:bg-slate-700" onClick={onClose} aria-label="Close dialog"><X size={17} /><span className="sm:hidden">Close</span></button></div><div className="min-h-0 overflow-y-auto">{children}</div></div></div>, document.body)
}

export function MetricCard({ label, value, note, icon, tone = 'blue' }: { label: string; value: string; note: string; icon: ReactNode; tone?: Tone }) {
  return <article className="card p-5"><div className="flex items-start justify-between"><div><p className="text-xs font-bold uppercase tracking-wider text-slate-400">{label}</p><p className="mt-2 text-3xl font-black">{value}</p></div><span className={`flex h-9 w-9 items-center justify-center rounded-xl ${tones[tone]}`}>{icon}</span></div><p className="mt-2 text-[11px] font-bold text-slate-500 dark:text-slate-400">{note}</p></article>
}

export function Terminal({ lines }: { lines: string[] }) {
  return <div className="overflow-hidden rounded-2xl bg-slate-950 font-mono text-xs text-slate-300 shadow-lg"><div className="flex h-9 items-center gap-1.5 border-b border-slate-800 px-4"><span className="h-2.5 w-2.5 rounded-full bg-rose-500" /><span className="h-2.5 w-2.5 rounded-full bg-amber-500" /><span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /></div><div className="max-h-72 overflow-auto p-4 leading-6">{lines.map((line, index) => <div key={`${line}-${index}`} className={line.startsWith('$') ? 'text-emerald-400' : line.includes('SUCCESS') ? 'text-blue-300' : ''}>{line || '\u00a0'}</div>)}</div></div>
}

export function ModuleWorkspace({ label, children, sections = ['Overview', 'Logs', 'Audit'], activeSection, onSectionChange }: { label: string; children: ReactNode; sections?: string[]; activeSection?: string; onSectionChange?: (section: string) => void }) {
  const icons = [LayoutDashboard, ScrollText, ClipboardCheck]
  return <div className={`grid gap-5 ${sections.length ? 'xl:grid-cols-[210px_1fr]' : ''}`}>{sections.length > 0 && <aside className="card h-fit overflow-hidden xl:sticky xl:top-24"><div className="border-b px-4 py-4"><p className="text-[10px] font-black uppercase tracking-widest text-slate-400">{label}</p></div><nav className="space-y-1 p-3">{sections.map((section, index) => { const Icon = icons[index] ?? ScrollText; const active = activeSection ? activeSection === section : index === 0; return <button key={section} onClick={() => onSectionChange?.(section)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-xs font-bold ${active ? 'bg-blue-50 text-brand-600 dark:bg-blue-950/40' : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-800'}`}><Icon size={15} />{section}</button> })}</nav></aside>}<div className="min-w-0 space-y-6">{children}</div></div>
}