import { useState } from 'react'
import { ArrowDown, ArrowUp, Plus, RefreshCw, Save, Trash2 } from 'lucide-react'
import { useManualResource, useManualWrite, type SessionProps } from './api'

type Rule = { match: string; assigneeId: string; onlineIT?: boolean }
type Settings = { enabled: boolean; allowNewChats: boolean; fallbackAssigneeId: string; routes: Rule[] }
type Agent = { id: string; fullName: string; role: string; online: boolean }
type Payload = { settings: Settings; agents: Agent[] }

export function ChatAssignmentSection(props: SessionProps) {
  const [revision, setRevision] = useState(0)
  const [saved, setSaved] = useState(false)
  const resource = useManualResource<Payload>(props, '/settings/chat', revision)
  return <section aria-label="Chat assignment" className="space-y-5">
    <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-bold">Chat assignment</h2><button className="icon-button" title="Reload chat settings" aria-label="Reload chat settings" disabled={resource.loading} onClick={() => { setSaved(false); setRevision(value => value + 1) }}><RefreshCw size={18} /></button></div>
    {saved && <p role="status">Chat assignment settings saved.</p>}
    {resource.loading ? <p role="status">Loading chat settings...</p> : resource.error ? <p role="alert">{resource.error}</p> : resource.data && <AssignmentForm key={revision} {...props} data={resource.data} onSaved={() => { setSaved(true); setRevision(value => value + 1) }} />}
  </section>
}

function AssignmentForm({ data, onSaved, ...props }: SessionProps & { data: Payload; onSaved: () => void }) {
  const [settings, setSettings] = useState<Settings>(data.settings)
  const writer = useManualWrite(props)
  const knownAgent = (id: string) => data.agents.some(agent => agent.id === id)
  const valid = settings.routes.length <= 50 && settings.routes.every(rule => rule.match.trim() && (rule.onlineIT || knownAgent(rule.assigneeId))) && (!settings.fallbackAssigneeId || knownAgent(settings.fallbackAssigneeId))
  const update = (index: number, patch: Partial<Rule>) => setSettings(current => ({ ...current, routes: current.routes.map((rule, position) => position === index ? { ...rule, ...patch } : rule) }))
  const move = (index: number, direction: number) => setSettings(current => { const routes = [...current.routes]; [routes[index], routes[index + direction]] = [routes[index + direction], routes[index]]; return { ...current, routes } })
  const examples = () => {
    const person = (name: string) => { const matches = data.agents.filter(agent => agent.fullName.toLowerCase() === name || agent.fullName.toLowerCase().startsWith(`${name} `)); return matches.length === 1 ? matches[0].id : '' }
    setSettings(current => ({ ...current, enabled: true, routes: [
      { match: 'software installation', assigneeId: '', onlineIT: true },
      { match: 'laptop issue', assigneeId: person('rakshith') },
      { match: 'software issue', assigneeId: person('muhammed gani') },
    ] }))
  }
  return <form className="space-y-5" onSubmit={event => { event.preventDefault(); if (valid) void writer.save('/settings/chat', settings, onSaved, 'PUT') }}>
    <fieldset disabled={writer.saving} className="min-w-0 space-y-5">
      <div className="flex flex-wrap gap-6"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.enabled} onChange={event => setSettings({ ...settings, enabled: event.target.checked })} />Automatic chat assignment</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.allowNewChats} onChange={event => setSettings({ ...settings, allowNewChats: event.target.checked })} />Allow new support chats</label></div>
      <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">Issue rules</h3>{!settings.routes.length && <button type="button" className="secondary-button" onClick={examples}>Use example rules</button>}</div>
      <ol className="space-y-4">{settings.routes.map((rule, index) => <li key={index} className="grid min-w-0 gap-3 border-b pb-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <label className="min-w-0 text-sm">Issue {index + 1}<input className="field mt-1 w-full" value={rule.match} maxLength={160} required onChange={event => update(index, { match: event.target.value })} /></label>
        <label className="min-w-0 text-sm">Assign issue {index + 1} to<select className="field mt-1 w-full" value={rule.onlineIT ? 'online_it' : rule.assigneeId} required onChange={event => update(index, { onlineIT: event.target.value === 'online_it', assigneeId: event.target.value === 'online_it' ? '' : event.target.value })}><option value="">Select a person</option><option value="online_it">Online IT team member</option>{data.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.fullName} ({agent.online ? 'online' : 'offline'})</option>)}</select></label>
        <div className="flex items-end gap-1"><button type="button" className="icon-button" aria-label={`Move issue ${index + 1} up`} title="Move rule up" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={16} /></button><button type="button" className="icon-button" aria-label={`Move issue ${index + 1} down`} title="Move rule down" disabled={index === settings.routes.length - 1} onClick={() => move(index, 1)}><ArrowDown size={16} /></button><button type="button" className="icon-button" aria-label={`Remove issue ${index + 1}`} title="Remove rule" onClick={() => setSettings(current => ({ ...current, routes: current.routes.filter((_, position) => position !== index) }))}><Trash2 size={16} /></button></div>
      </li>)}</ol>
      <button type="button" className="secondary-button" disabled={settings.routes.length >= 50} onClick={() => setSettings(current => ({ ...current, routes: [...current.routes, { match: '', assigneeId: '', onlineIT: true }] }))}><Plus size={16} />Add issue rule</button>
      <label className="block max-w-md text-sm">Unmatched issue assignee<select className="field mt-1 w-full" value={settings.fallbackAssigneeId} onChange={event => setSettings({ ...settings, fallbackAssigneeId: event.target.value })}><option value="">Leave unassigned</option>{data.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.fullName}</option>)}</select></label>
      {writer.error && <p role="alert">{writer.error}</p>}
      <button className="primary-button" disabled={!valid || writer.saving}><Save size={16} />{writer.saving ? 'Saving...' : 'Save chat settings'}</button>
    </fieldset>
  </form>
}