import { useId, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'

export interface GatepassChoice {
  id: string
  label: string
  display: string
  keywords: string
}

export function GatepassRecordPicker({ label, value, choices, onSelect, describedBy, placeholder = 'Search saved records', search, onSearch, clearOnEdit = false, suggestionsOnTyping = false }: {
  label: string
  value: string
  choices: GatepassChoice[]
  onSelect: (id: string) => void
  describedBy?: string
  placeholder?: string
  search?: string
  onSearch?: (value: string) => void
  clearOnEdit?: boolean
  suggestionsOnTyping?: boolean
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const selected = choices.find(choice => choice.id === value)
  const open = query !== null
  const text = search ?? query ?? selected?.display ?? ''
  const matches = choices.filter(choice => `${choice.label} ${choice.keywords}`.toLowerCase().includes((query ?? '').trim().toLowerCase()))
  const showList = open && (!suggestionsOnTyping || Boolean(query?.trim()) && matches.length > 0)
  const activeChoice = matches[Math.min(active, Math.max(0, matches.length - 1))]
  function choose(choice: GatepassChoice) {
    onSelect(choice.id)
    setQuery(null)
    setActive(0)
  }
  return <div className="relative min-w-0 text-xs font-bold text-slate-500" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setQuery(null)
  }}>
    <label htmlFor={id}>{label}</label>
    <div className="relative mt-2">
      <input ref={input} id={id} className="field pr-16" role="combobox" autoComplete="off"
        aria-autocomplete="list" aria-expanded={showList} aria-controls={`${id}-options`}
        aria-activedescendant={showList && activeChoice ? `${id}-option-${choices.indexOf(activeChoice)}` : undefined}
        aria-describedby={describedBy} value={text} placeholder={placeholder}
        onFocus={() => { setQuery(search ?? ''); setActive(0) }}
        onChange={event => { if (clearOnEdit && value) onSelect(''); setQuery(event.target.value); setActive(0); onSearch?.(event.target.value) }}
        onKeyDown={event => {
          if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setQuery(null) }
          else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && (!suggestionsOnTyping || showList)) {
            event.preventDefault()
            if (!open) { setQuery(''); setActive(event.key === 'ArrowDown' ? 0 : Math.max(0, matches.length - 1)) }
            else setActive(current => Math.max(0, Math.min(matches.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))))
          } else if (event.key === 'Enter' && open) {
            event.preventDefault()
            if (showList && activeChoice) choose(activeChoice)
          }
        }} />
      <div className="absolute inset-y-0 right-1 flex items-center">
        {(value || text) && <button type="button" className="p-1.5" aria-label={`Clear ${label}`} title={`Clear ${label}`}
          onClick={() => { onSelect(''); onSearch?.(''); setQuery(null) }}><X size={14} /></button>}
        {!suggestionsOnTyping && <button type="button" className="p-1.5" aria-label={`Show ${label} suggestions`} title={`Show ${label} suggestions`}
          onClick={() => { input.current?.focus(); setQuery(''); setActive(0) }}><ChevronDown size={14} /></button>}
      </div>
    </div>
    {showList && <ul id={`${id}-options`} role="listbox" aria-label={`${label} suggestions`}
      className="absolute left-0 right-0 z-50 mt-1 max-h-56 overflow-y-auto rounded-md border bg-white p-1 text-slate-800 shadow-lg dark:bg-slate-900 dark:text-slate-100">
      {matches.length ? matches.map(choice => <li key={choice.id} id={`${id}-option-${choices.indexOf(choice)}`}
        role="option" aria-selected={choice.id === value} data-record-id={choice.id}
        className={`cursor-pointer break-words rounded px-2 py-2 text-xs ${choice === activeChoice ? 'bg-blue-50 dark:bg-slate-800' : ''}`}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(choice)}>{choice.label}</li>) : <li role="presentation" className="px-2 py-3 font-normal">No matching saved records.</li>}
    </ul>}
  </div>
}