import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, MessageCircle, Plus, RefreshCw, Send } from 'lucide-react'
import { getToken, subscribeAuth } from '../lib/auth'
import { readJson } from '../lib/api'
import { useIndiaDay } from '../lib/indiaDay'
import { ChatResizeHandle } from './ChatResizeHandle'
import { Modal } from './ui'

type Person = { id: string; fullName: string; role?: string }
type Participant = Person & { isMember: boolean }
type Channel = { id: string; name: string; status: string; primaryOwner?: Person; createdBy?: Person; members?: Person[] }
type InboxChannel = Channel & { messageCount?: number; latestMessage?: { createdAt: string } }
type Message = { id: string; body: string; createdAt: string; author: Person }
type Page<T> = { items: T[]; total: number }
const chatName = (name: string) => name.trim().toLowerCase() === 'general support' ? 'Chat' : name
function participantNames(channel: Channel, userId: string) {
  const people = [...(channel.members ?? []), channel.createdBy, channel.primaryOwner]
  const seen = new Set<string>([userId])
  const names: string[] = []
  for (const person of people) {
    if (!person || seen.has(person.id)) continue
    seen.add(person.id)
    if (person.fullName.trim()) names.push(person.fullName.trim())
  }
  return names.join(', ') || 'No other participants'
}

const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')
const presenceLeaseKey = 'itms_chat_presence_lease'
const presenceLeaseCooldown = 30_000
const PresenceContext = createContext<{ presence: ReturnType<typeof useSupportPresence>; enabled: boolean; retryIdentity: () => void } | null>(null)

type PresenceLease = { owner: string; at: number; target: boolean; state: 'pending' | 'confirmed' | 'failed' }

function readPresenceLease(): PresenceLease | null {
  const value = window.localStorage.getItem(presenceLeaseKey)
  if (!value) return null
  const [owner, timestamp, target, state] = value.split('|')
  const at = Number(timestamp)
  if (!owner || !Number.isSafeInteger(at) || (target !== '0' && target !== '1') ||
    (state !== 'pending' && state !== 'confirmed' && state !== 'failed')) return null
  return { owner, at, target: target === '1', state }
}

function claimPresenceLease(owner: string, target: boolean, force: boolean): PresenceLease | null {
  const now = Date.now()
  const current = readPresenceLease()
  if (!force && current && now >= current.at && now - current.at < presenceLeaseCooldown) return null
  const lease: PresenceLease = { owner, at: now, target, state: 'pending' }
  window.localStorage.setItem(presenceLeaseKey, `${owner}|${now}|${target ? '1' : '0'}|pending`)
  const claimed = readPresenceLease()
  return claimed?.owner === owner && claimed.at === now && claimed.target === target && claimed.state === 'pending'
    ? lease
    : null
}

function writePresenceLease(lease: PresenceLease) {
  window.localStorage.setItem(presenceLeaseKey, `${lease.owner}|${lease.at}|${lease.target ? '1' : '0'}|${lease.state}`)
}

async function request<T>(token: string, path: string, signal: AbortSignal, body?: object): Promise<T> {
  if (!token || token !== getToken() || signal.aborted) throw new Error('Account changed')
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  const timeout = window.setTimeout(abort, 10000)
  try {
    const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', signal: controller.signal, cache: 'no-store', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    if (!response.ok) throw new Error(response.status === 429 ? 'Too many requests. Wait before refreshing.' : response.status === 401 || response.status === 403 ? 'Support access unavailable. Sign in with an authorized account.' : 'Support request unavailable.')
    const result = await readJson<T>(response)
    if (token !== getToken() || signal.aborted || controller.signal.aborted) throw new Error('Account changed or request timed out')
    return result
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) throw new Error('Support request timed out. Try refreshing.')
    throw error
  } finally { window.clearTimeout(timeout); signal.removeEventListener('abort', abort) }
}

async function updateChatChannel<T>(token: string, path: string, signal: AbortSignal, body?: object): Promise<T> {
  if (!token || token !== getToken() || signal.aborted) throw new Error('Account changed')
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  const timeout = window.setTimeout(abort, 10000)
  try {
    const response = await fetch(`${base}${path}`, { method: 'PUT', signal: controller.signal, cache: 'no-store', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Support access unavailable. Sign in with an authorized account.' : response.status === 409 ? 'Chat or team availability changed. Refresh and try again.' : 'Chat status could not be updated.')
    const result = await readJson<T>(response)
    if (token !== getToken() || signal.aborted || controller.signal.aborted) throw new Error('Account changed or request timed out')
    return result
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) throw new Error('Support request timed out. Try refreshing.')
    throw error
  } finally { window.clearTimeout(timeout); signal.removeEventListener('abort', abort) }
}

function useSupportResource<T>(token: string, path: string | null, revision = 0, polling = false) {
  const key = JSON.stringify([token, path, revision])
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key: '' })
  useEffect(() => {
    if (!token || !path) return
    const controller = new AbortController()
    let pending = false
    const load = async () => {
      if (pending || document.visibilityState === 'hidden') return
      pending = true
      try { const data = await request<T>(token, path, controller.signal); setState({ key, data }) }
      catch (failure) { if (!controller.signal.aborted && getToken() === token) setState({ key, error: failure instanceof Error ? failure.message : 'Support unavailable.' }) }
      finally { pending = false }
    }
    const unsubscribe = subscribeAuth(() => { if (getToken() !== token) controller.abort() })
    void load()
    const timer = polling ? window.setInterval(() => void load(), 15000) : undefined
    const visible = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', visible)
    return () => { controller.abort(); unsubscribe(); window.clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [token, path, key, polling])
  return state.key === key && getToken() === token ? { ...state, loading: false } : { data: undefined, error: undefined, loading: !!token && !!path }
}

export function SupportChatInbox({ token, onActivity, children }: { token: string; onActivity: () => void; children?: ReactNode }) {
  const [identityRevision, setIdentityRevision] = useState(0)
  const me = useSupportResource<{ id: string; role: string }>(token, '/auth/me', identityRevision)
  const readable = !!me.data?.id && ['employee', 'it_team', 'super_admin', 'admin'].includes(me.data.role)
  const staff = readable && ['it_team', 'super_admin', 'admin'].includes(me.data!.role)
  const presence = useSupportPresence(token, staff)
  const channels = useSupportResource<Page<InboxChannel>>(token, readable ? '/chat/channels?kind=support&page=1&pageSize=20' : null, 0, true)
  const previous = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    if (!channels.data || getToken() !== token) return
    const current = new Map(channels.data.items.filter(item => item.status !== 'closed').map(item => [item.id, `${item.messageCount ?? 0}:${item.latestMessage?.createdAt ?? ''}`]))
    if (!previous.current) { previous.current = current; return }
    const controller = new AbortController()
    const unsubscribe = subscribeAuth(() => { if (getToken() !== token) controller.abort() })
    void Promise.all([...current].filter(([id, stamp]) => previous.current!.get(id) !== stamp).map(async ([id, stamp]) => {
      try {
        const latest = await request<Page<Message>>(token, `/chat/channels/${encodeURIComponent(id)}/messages?page=1&pageSize=1`, controller.signal)
        previous.current!.set(id, stamp)
        return !!latest.items[0]?.author.id && latest.items[0].author.id !== me.data?.id
      } catch { return false }
    })).then(incoming => {
      if (!controller.signal.aborted && getToken() === token && incoming.some(Boolean)) onActivity()
    })
    return () => { controller.abort(); unsubscribe() }
  }, [channels.data, me.data?.id, token, onActivity])
  return <PresenceContext.Provider value={{ presence, enabled: staff, retryIdentity: () => setIdentityRevision(value => value + 1) }}>{children}</PresenceContext.Provider>
}

function useSupportPresence(token: string, enabled: boolean) {
  const [available, setAvailable] = useState(true)
  const [confirmed, setConfirmed] = useState<boolean | null>(null)
  const [error, setError] = useState('')
  const desired = useRef(available)
  const owner = useRef(`${Date.now()}-${Math.random().toString(36).slice(2)}`).current
  const refresh = useRef<() => void>(() => {})
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let pending = false
    let sent: boolean | undefined
    let queued = false
    let lastAttemptedTarget: boolean | undefined
    let lastAttemptAt = 0
    const update = async (force = false) => {
      if (desired.current && document.visibilityState !== 'visible') return
      const target = desired.current
      if (pending) {
        if (target !== sent) { queued = true; setConfirmed(null) }
        return
      }
      const now = Date.now()
      if (!force && target === lastAttemptedTarget && now - lastAttemptAt < presenceLeaseCooldown) return
      let lease: PresenceLease | null = null
      try {
        const existing = readPresenceLease()
        if (!force && existing && now >= existing.at && now - existing.at < presenceLeaseCooldown) {
          if (existing.state === 'confirmed' && existing.target === target) {
            lastAttemptedTarget = target
            lastAttemptAt = existing.at
            setConfirmed(target)
            setError('')
          }
          return
        }
        lease = claimPresenceLease(owner, target, force)
        if (!lease) return
        pending = true
        queued = false
        sent = target
        lastAttemptedTarget = target
        lastAttemptAt = lease.at
        setConfirmed(current => current === target ? current : null)
        const result = await request<{ available: unknown }>(token, '/chat/presence', controller.signal, { available: target })
        if (result.available !== target) throw new Error('Invalid availability response')
        if (!controller.signal.aborted) {
          const current = readPresenceLease()
          if (current?.owner === owner && current.at === lease.at) writePresenceLease({ ...lease, state: 'confirmed' })
          if (!queued) { setConfirmed(target); setError('') }
        }
      } catch {
        if (!controller.signal.aborted) {
          if (lease) {
            const current = readPresenceLease()
            if (current?.owner === owner && current.at === lease.at) writePresenceLease({ ...lease, state: 'failed' })
          }
          setConfirmed(null)
          setError('Availability not confirmed. Retry to update it.')
        }
      } finally {
        if (lease) {
          pending = false
          if (!controller.signal.aborted && queued) void update(true)
        }
      }
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== presenceLeaseKey || !event.newValue) return
      const lease = readPresenceLease()
      if (!lease || lease.state !== 'confirmed') return
      const age = Date.now() - lease.at
      if (age < 0 || age >= presenceLeaseCooldown) return
      desired.current = lease.target
      setAvailable(lease.target)
      setConfirmed(lease.target)
      setError('')
    }
    const existing = readPresenceLease()
    if (existing?.state === 'confirmed' && Date.now() >= existing.at &&
      Date.now() - existing.at < presenceLeaseCooldown) {
      desired.current = existing.target
      lastAttemptedTarget = existing.target
      lastAttemptAt = existing.at
      setAvailable(existing.target)
      setConfirmed(existing.target)
    }
    refresh.current = () => { setConfirmed(null); void update(true) }
    void update()
    const timer = window.setInterval(() => { if (desired.current && document.visibilityState === 'visible') void update() }, 30000)
    const onVisibilityChange = () => void update()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('storage', onStorage)
    return () => { controller.abort(); refresh.current = () => {}; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibilityChange); window.removeEventListener('storage', onStorage) }
  }, [token, enabled, owner])
  useEffect(() => {
    if (desired.current !== available) {
      desired.current = available
      refresh.current()
    }
  }, [available])
  return { available, setAvailable, confirmed, error, retry: () => refresh.current() }
}

function Availability({ token, name }: { token: string; name: string }) {
  const context = useContext(PresenceContext)
  if (!context) return <StandaloneAvailability token={token} name={name} />
  if (!context.enabled) return <div className="flex items-center gap-2 border-b px-4 py-2 text-xs"><span className="font-semibold">{name}</span><span role="status" className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-orange-500" />Availability unconfirmed</span><button type="button" className="text-brand-600 underline" onClick={context.retryIdentity}>Retry availability</button></div>
  return <AvailabilityControls presence={context.presence} name={name} />
}

function StandaloneAvailability({ token, name }: { token: string; name: string }) {
  const presence = useSupportPresence(token, true)
  return <AvailabilityControls presence={presence} name={name} />
}

function AvailabilityControls({ presence, name }: { presence: ReturnType<typeof useSupportPresence>; name: string }) {
  const { available, setAvailable, confirmed, error, retry } = presence
  const status = confirmed === null ? 'Unconfirmed' : confirmed ? 'Online' : 'Offline'
  return <div className="border-b px-4 py-1.5 text-xs text-slate-600 dark:text-slate-300"><div className="flex flex-wrap items-center gap-x-3 gap-y-1"><span className="font-semibold text-slate-900 dark:text-white">{name}</span><span className="flex items-center gap-1.5" role="status"><span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${confirmed === null ? 'bg-orange-500' : confirmed ? 'bg-emerald-500' : 'bg-red-500'}`} />{status}</span><label className="ml-auto flex items-center gap-2"><input type="checkbox" aria-label="Available for chats" checked={available} onChange={event => setAvailable(event.target.checked)} />Available for chats</label></div>{error && <p role="alert" className="mt-2">{error} <button type="button" className="text-brand-600 underline" onClick={retry}>Retry availability</button></p>}</div>
}

function ChatSidebar({ children, width, onResize }: { children: ReactNode; width: number; onResize: (width: number) => void }) {
  const sidebar = useRef<HTMLElement>(null)
  const [maxWidth, setMaxWidth] = useState(380)
  useEffect(() => {
    const parent = sidebar.current?.parentElement
    if (!parent) return
    const update = () => setMaxWidth(Math.max(160, Math.min(380, parent.clientWidth - 220)))
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])
  const actualWidth = Math.min(width, maxWidth)
  return <aside ref={sidebar} className="chat-sidebar relative flex w-full shrink-0 flex-col border-r border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900" style={{ '--chat-sidebar-width': `${actualWidth}px` } as CSSProperties}>
    {children}
    <ChatResizeHandle label="Resize recent chats width" value={actualWidth} min={160} max={maxWidth} direction={1} onResize={onResize} className="chat-sidebar-resize absolute inset-y-0 right-0 z-10 hidden w-3" />
  </aside>
}

export function SupportChat({ token, showRecentChats, onShowRecentChatsChange }: { token: string; showRecentChats?: boolean; onShowRecentChatsChange?: (show: boolean) => void }) {
  const [sidebarWidth, setSidebarWidth] = useState(180)
  const [localShowRecentChats, setLocalShowRecentChats] = useState(true)
  const listVisible = showRecentChats ?? localShowRecentChats
  const setListVisible = (show: boolean) => {
    setLocalShowRecentChats(show)
    onShowRecentChatsChange?.(show)
  }
  if (!token) return <div className="flex min-h-0 flex-1" style={{ containerType: 'inline-size', containerName: 'chat-workspace' }}>
    {listVisible && <ChatSidebar width={sidebarWidth} onResize={setSidebarWidth}>
      <div className="p-4">
      <h4 className="px-2 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Recent chats</h4>
      <p className="px-2 py-2 text-sm text-slate-500">Sign in to see your chats.</p>
      </div>
    </ChatSidebar>}
    <main className={`${listVisible ? 'chat-main-with-list hidden' : 'flex'} min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-white p-6 text-center dark:bg-slate-950`}>
      <MessageCircle size={28} className="text-slate-400" />
      <p className="text-sm text-slate-500">Sign in to view and send messages.</p>
      <button className="primary-button" onClick={() => window.dispatchEvent(new Event('itms-open-sign-in'))}>Sign in</button>
    </main>
  </div>
  return <SupportSession key={token} token={token} showRecentChats={listVisible} onShowRecentChatsChange={setListVisible} sidebarWidth={sidebarWidth} onSidebarResize={setSidebarWidth} />
}

function SupportSession({ token, showRecentChats, onShowRecentChatsChange, sidebarWidth, onSidebarResize }: { token: string; showRecentChats: boolean; onShowRecentChatsChange?: (show: boolean) => void; sidebarWidth: number; onSidebarResize: (width: number) => void }) {
  const [connectionRevision, setConnectionRevision] = useState(0)
  const me = useSupportResource<{ id: string; role: string; full_name?: string; emp_id?: string }>(token, '/auth/me', connectionRevision)
  const readable = !!me.data?.id && ['employee', 'it_team', 'super_admin', 'admin'].includes(me.data.role)
  const staff = readable && ['it_team', 'super_admin', 'admin'].includes(me.data!.role)
  const [revision, setRevision] = useState(0)
  const [page, setPage] = useState(1)
  const [showHistory, setShowHistory] = useState(false)
  const today = useIndiaDay()
  useEffect(() => { setPage(1) }, [today])
  const channelQuery = showHistory ? 'history=true' : 'created_today=true'
  const channels = useSupportResource<Page<Channel>>(token, readable ? `/chat/channels?kind=support&page=${page}&pageSize=20&${channelQuery}&day=${today}` : null, revision, true)
  const options = useSupportResource<{ allowNewChats: boolean }>(token, readable ? '/chat/support-options' : null, revision)
  const [selectedId, setSelectedId] = useState('')
  const [startingChat, setStartingChat] = useState(false)
  const [draft, setDraft] = useState('')
  const [messagePage, setMessagePage] = useState(1)
  const [messageRevision, setMessageRevision] = useState(0)
  const selected = channels.data?.items?.find(item => item.id === selectedId)
  const messages = useSupportResource<Page<Message>>(token, selected ? `/chat/channels/${encodeURIComponent(selected.id)}/messages?page=${messagePage}&pageSize=100` : null, messageRevision, true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [approvalOpen, setApprovalOpen] = useState(false)
  const [approvalTitle, setApprovalTitle] = useState('')
  const [approvalDescription, setApprovalDescription] = useState('')
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignTo, setAssignTo] = useState('')
  const [participantsOpen, setParticipantsOpen] = useState(false)
  const [participantPage, setParticipantPage] = useState(1)
  const [participantSearch, setParticipantSearch] = useState('')
  const [debouncedParticipantSearch, setDebouncedParticipantSearch] = useState('')
  const [participantRevision, setParticipantRevision] = useState(0)
  const [newParticipants, setNewParticipants] = useState<Person[]>([])
  const [participantResults, setParticipantResults] = useState<{ key: string; items: Participant[] }>({ key: '', items: [] })
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedParticipantSearch(participantSearch.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [participantSearch])
  const searchPending = participantSearch.trim() !== debouncedParticipantSearch
  const searchParam = debouncedParticipantSearch ? `&search=${encodeURIComponent(debouncedParticipantSearch)}` : ''
  const participantPath = startingChat ? `/chat/participants?page=${participantPage}${searchParam}` : null
  const participants = useSupportResource<{ items: Participant[]; hasMore: boolean }>(token, participantsOpen && !searchPending ? participantPath : null, revision + participantRevision)
  const participantKey = JSON.stringify([token, startingChat, selected?.id, debouncedParticipantSearch, revision])
  useEffect(() => {
    if (!participantsOpen || searchPending || !participants.data) return
    const items = participants.data.items
    setParticipantResults(previous => {
      if (participantPage === 1 || previous.key !== participantKey) return { key: participantKey, items }
      const ids = new Set(previous.items.map(person => person.id))
      return { key: participantKey, items: [...previous.items, ...items.filter(person => !ids.has(person.id))] }
    })
  }, [participantsOpen, searchPending, participants.data, participantKey, participantPage])
  const displayedParticipants = !searchPending && participantResults.key === participantKey ? participantResults.items : []
  const agents = useSupportResource<{ items: Person[] }>(token, staff && assignOpen ? '/chat/presence/agents' : null, revision, true)
  const [failedRevision, setFailedRevision] = useState<number | null>(null)
  const uncertain = failedRevision !== null && (revision <= failedRevision || !channels.data || (!!selectedId && !messages.data))
  const controller = useRef<AbortController | null>(null)
  const lock = useRef(false)
  const initialConversationChosen = useRef(false)
  const end = useRef<HTMLDivElement>(null)
  const workspace = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const focusComposer = useRef(false)
  useEffect(() => {
    const current = new AbortController(); controller.current = current
    const unsubscribe = subscribeAuth(() => { if (getToken() !== token) current.abort() })
    return () => { current.abort(); unsubscribe() }
  }, [token])
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }) }, [messages.data?.items?.length, selectedId])
  useEffect(() => {
    if (focusComposer.current && !participantsOpen && startingChat && newParticipants.length > 0) {
      focusComposer.current = false
      composer.current?.focus()
    }
  }, [participantsOpen, startingChat, newParticipants])
  useEffect(() => {
    if (initialConversationChosen.current || !channels.data) return
    initialConversationChosen.current = true
    const latest = channels.data.items[0]
    if (latest) setSelectedId(latest.id)
    if ((workspace.current?.clientWidth || window.innerWidth) < 460) onShowRecentChatsChange?.(false)
  }, [channels.data, onShowRecentChatsChange])
  const refresh = () => { setRevision(value => value + 1); setMessageRevision(value => value + 1); setError('') }
  const startNewChat = () => {
    if ((draft.trim() || newParticipants.length > 0) && !window.confirm('Starting a new chat will discard the current draft and selected people. Continue?')) return
    initialConversationChosen.current = true
    setSelectedId(''); setStartingChat(true); setDraft(''); setNewParticipants([])
    setAssignOpen(false); setAssignTo(''); setMessagePage(1)
    setParticipantPage(1); setParticipantSearch(''); setParticipantResults({ key: '', items: [] }); setParticipantsOpen(true)
    setError(''); setNotice('')
    if ((workspace.current?.clientWidth || window.innerWidth) < 460) onShowRecentChatsChange?.(false)
  }
  const selectConversation = (id: string) => {
    if (startingChat && (draft.trim() || newParticipants.length > 0) && !window.confirm('Switching conversations will discard your new chat draft and selected people. Continue?')) return
    initialConversationChosen.current = true
    if (startingChat) setDraft('')
    setAssignOpen(false); setAssignTo('')
    setParticipantsOpen(false); setParticipantPage(1); setParticipantSearch(''); setParticipantResults({ key: '', items: [] })
    setStartingChat(false); setNewParticipants([])
    setSelectedId(id); setMessagePage(1)
    if ((workspace.current?.clientWidth || window.innerWidth) < 460) onShowRecentChatsChange?.(false)
  }
  const showConversationList = () => {
    onShowRecentChatsChange?.(true)
  }
  const cannotSend = busy || uncertain || (startingChat ? options.data?.allowNewChats !== true || newParticipants.length === 0 : !selected || selected.status === 'closed')
  async function send() {
    const signal = controller.current?.signal
    const body = draft.trim()
    if (!readable || (!selected && !startingChat) || !body || !signal || signal.aborted || lock.current || cannotSend) return
    lock.current = true; setBusy(true); setError('')
    try {
      if (startingChat) {
        const result = await request<{ id: string }>(token, '/chat/channels', signal, { name: 'General support', kind: 'support', initialMessage: body, supportParticipantIds: newParticipants.map(person => person.id) })
        if (!result.id) throw new Error('Chat was not confirmed')
        setSelectedId(result.id); setStartingChat(false); setNewParticipants([]); setPage(1); setRevision(value => value + 1)
      } else if (selected) {
        await request<Message>(token, `/chat/channels/${encodeURIComponent(selected.id)}/messages`, signal, { body })
      }
      setDraft(''); setMessagePage(1); setMessageRevision(value => value + 1)
    } catch {
      if (!signal.aborted && getToken() === token) { setError('Delivery not confirmed. Refresh conversations and check history before sending again.'); setFailedRevision(revision) }
    } finally { if (!signal.aborted && getToken() === token) { lock.current = false; setBusy(false) } }
  }
  async function changeChannelStatus(channel: Channel, action: 'close' | 'reopen') {
    const signal = controller.current?.signal
    if (!signal || signal.aborted || lock.current || busy) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const result = await updateChatChannel<{ ticketNumber?: string }>(token, `/chat/channels/${encodeURIComponent(channel.id)}/${action}`, signal)
      if (action === 'reopen') {
        setSelectedId(channel.id)
        setMessagePage(1)
        if ((workspace.current?.clientWidth || window.innerWidth) < 460) onShowRecentChatsChange?.(false)
      }
      setNotice(action === 'close'
        ? `Chat closed. Ticket ${result.ticketNumber || 'created'} is available in Requests.`
        : 'Chat reopened with the same issue. You can continue messaging.')
      setRevision(value => value + 1); setMessageRevision(value => value + 1)
    } catch (failure) {
      if (!signal.aborted && getToken() === token) setError(failure instanceof Error ? failure.message : 'Chat status could not be updated.')
    } finally { if (!signal.aborted && getToken() === token) { lock.current = false; setBusy(false) } }
  }
  async function submitApproval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const signal = controller.current?.signal
    const title = approvalTitle.trim()
    const description = approvalDescription.trim()
    if (!staff || !selected || !signal || signal.aborted || lock.current || !title || !description) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const result = await request<{ id: string; ticketNumber?: string }>(token, '/me/requests', signal, {
        type: 'manager_approval',
        title: `Manager approval: ${title}`.slice(0, 200),
        description: `Requested from support chat ${selected.id} (${chatName(selected.name)}).\n\n${description}`,
        priority: 'medium',
      })
      if (!result.id) throw new Error('Approval request was not confirmed.')
      setApprovalOpen(false); setApprovalTitle(''); setApprovalDescription('')
      setNotice(`Approval request ${result.ticketNumber || result.id} created as a ticket. A manager is not automatically notified.`)
    } catch (failure) {
      if (!signal.aborted && getToken() === token) setError(failure instanceof Error ? failure.message : 'Approval request could not be submitted.')
    } finally { if (!signal.aborted && getToken() === token) { lock.current = false; setBusy(false) } }
  }
  async function assignChat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const signal = controller.current?.signal
    const channel = selected
    if (!staff || !channel || channel.status !== 'open' || !signal || signal.aborted || lock.current || !agents.data?.items.some(agent => agent.id === assignTo)) return
    lock.current = true; setBusy(true); setError(''); setNotice('')
    try {
      await updateChatChannel(token, `/chat/channels/${encodeURIComponent(channel.id)}/transfer`, signal, { ownerId: assignTo })
      setAssignOpen(false); setAssignTo('')
      setNotice('Chat reassigned to the selected IT team member.')
      setRevision(value => value + 1)
    } catch (failure) {
      if (!signal.aborted && getToken() === token) setError(failure instanceof Error ? failure.message : 'Chat assignment could not be updated.')
    } finally { if (!signal.aborted && getToken() === token) { lock.current = false; setBusy(false) } }
  }
  async function addParticipant(person: Participant) {
    if (!startingChat || searchPending || person.isMember || !displayedParticipants.some(item => item.id === person.id) || busy || lock.current || (!newParticipants.some(item => item.id === person.id) && newParticipants.length >= 50)) return
    setNewParticipants(current => current.some(item => item.id === person.id) ? current : [...current, person])
    focusComposer.current = true
    setParticipantsOpen(false)
  }
  if (me.loading) return <p role="status" className="p-4 text-sm">Connecting to IT support...</p>
  if (!readable) return <div className="space-y-3 p-4"><p role="alert" className="text-sm">{me.error || 'Support is unavailable for this account.'}</p><button className="secondary-button" onClick={() => setConnectionRevision(value => value + 1)}><RefreshCw size={16} />Retry connection</button></div>
  const visibleChannels = channels.data?.items ?? []
  return <div className="flex min-h-0 flex-1 flex-col">
    {staff ? <Availability token={token} name={me.data?.full_name || me.data?.emp_id || 'Signed-in user'} /> : <div className="flex items-center gap-2 border-b px-4 py-1.5 text-xs"><span className="font-semibold">{me.data?.full_name || me.data?.emp_id || 'Signed-in user'}</span><span role="status" className="flex items-center gap-1.5"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-orange-500" />Availability unconfirmed</span></div>}
    {(error || channels.error || options.error) && <div role="alert" className="border-b border-rose-200 bg-rose-50 px-4 py-2 text-xs text-rose-700">{error || channels.error || options.error} {(uncertain || channels.error || options.error) && <button type="button" className="ml-2 underline" disabled={busy || channels.loading} onClick={refresh}>Retry loading conversations</button>}</div>}
    <div ref={workspace} className="flex min-h-0 flex-1" style={{ containerType: 'inline-size', containerName: 'chat-workspace' }}>
      {showRecentChats && <ChatSidebar width={sidebarWidth} onResize={onSidebarResize}>
        <div className="flex items-center justify-between gap-1 px-2 py-2">
          <h3 className="text-xs font-bold text-slate-900 dark:text-white">Recent chats</h3>
        </div>
        <div className="px-2 pb-2"><button type="button" className="text-xs font-semibold text-brand-600 underline" onClick={() => { setShowHistory(value => !value); setPage(1) }}>{showHistory ? "Show today's chats" : 'Show chat history'}</button><p className="mt-1 text-[10px] text-slate-500">{showHistory ? 'All chats' : 'Today’s chats (India time)'}</p></div>
        {!selectedId && channels.data && <div className="chat-mobile-back px-2 pb-2"><button type="button" className="secondary-button" onClick={() => onShowRecentChatsChange?.(false)}>Open chat composer</button></div>}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-12">
          {channels.loading ? <p role="status" className="px-3 py-2 text-sm">Loading conversations...</p> : channels.data && visibleChannels.length === 0 && <p className="px-3 py-2 text-sm text-slate-500">No chats yet.</p>}
          {visibleChannels.map(channel => <div key={channel.id} className="mb-1 flex items-center gap-1">
            <button disabled={busy} className={`flex min-w-0 flex-1 items-center gap-2 rounded-full px-3 py-2 text-left transition-colors hover:bg-blue-50 dark:hover:bg-slate-800 ${selectedId === channel.id ? 'bg-blue-100 dark:bg-slate-800' : ''}`} onClick={() => selectConversation(channel.id)}>
              <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-200">{participantNames(channel, me.data!.id).slice(0, 1).toUpperCase()}</span>
              <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{participantNames(channel, me.data!.id)}</strong><span className="mt-0.5 block truncate text-xs text-slate-500 dark:text-slate-400">{[chatName(channel.name).toLowerCase() !== 'chat' ? chatName(channel.name) : '', channel.primaryOwner?.fullName ? `${channel.primaryOwner.fullName} · IT team` : 'Waiting for IT team'].filter(Boolean).join(' · ')}</span></span>
            </button>
          </div>)}
          {channels.data && (page > 1 || channels.data.total > page * 20) && <div className="flex items-center justify-center gap-3 py-2"><button className="icon-button" aria-label="Previous conversations" title="Previous conversations" disabled={page === 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={16} /></button><span className="text-xs">Page {page}</span><button className="icon-button" aria-label="Next conversations" title="Next conversations" disabled={channels.data.total <= page * 20} onClick={() => setPage(value => value + 1)}><ChevronRight size={16} /></button></div>}
        </div>
      </ChatSidebar>}
      <main className={`min-w-0 flex-1 flex-col bg-white dark:bg-slate-950 ${showRecentChats ? 'chat-main-with-list hidden' : 'flex'}`}>
        {selected ? <>
          <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
            <button className="icon-button chat-mobile-back" title="Back to chats" aria-label="Back to conversations" disabled={busy} onClick={showConversationList}><ArrowLeft size={16} /></button>
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-200">{chatName(selected.name).slice(0, 1).toUpperCase()}</span>
            <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-semibold">{chatName(selected.name)}</h3><p className="truncate text-xs text-slate-500">{selected.primaryOwner?.fullName ? `${selected.primaryOwner.fullName} - IT team` : 'Waiting for IT team'}</p></div>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-white px-3 py-2 dark:bg-slate-950">
            {notice && <p role="status" className="text-center text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>}
            <p role="status" className="pb-1 text-xs text-slate-600 dark:text-slate-300">{selected.primaryOwner?.fullName ? `Hi! Your chat is assigned to ${selected.primaryOwner.fullName} from the IT team.` : 'Your chat is waiting for an IT-team assignee.'}</p>
            {messages.error && <p role="alert" className="text-xs">{messages.error}</p>}
            {messages.loading && <p role="status" className="text-xs">Loading messages...</p>}
            {messages.data && (messagePage > 1 || messages.data.total > messagePage * 100) && <div className="flex justify-center gap-2"><button className="icon-button" title="Older messages" aria-label="Older messages" disabled={messages.data.total <= messagePage * 100} onClick={() => setMessagePage(value => value + 1)}><ChevronLeft size={16} /></button><button className="icon-button" title="Newer messages" aria-label="Newer messages" disabled={messagePage === 1} onClick={() => setMessagePage(value => value - 1)}><ChevronRight size={16} /></button></div>}
            {messages.data?.items?.map(message => <article key={message.id} className={`max-w-[80%] break-words rounded-2xl px-4 py-2 text-sm ${message.author.id === me.data?.id ? 'ml-auto bg-blue-600 text-white' : 'mr-auto bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100'}`}><strong className="mb-1 block text-xs font-medium opacity-80">{message.author.fullName}{selected.primaryOwner?.id === message.author.id ? ' · IT team' : ''}</strong><p className="whitespace-pre-wrap">{message.body}</p><time className="mt-1 block text-[10px] opacity-70">{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></article>)}
            {selected.status === 'closed' && <p role="status" className="text-center text-sm text-slate-500">This chat is closed.</p>}
            <div ref={end} />
          </div>
          {approvalOpen && <Modal title="Request manager approval" onClose={() => { if (!busy) setApprovalOpen(false) }}><form className="space-y-4 p-5" onSubmit={event => void submitApproval(event)}><p className="text-sm text-slate-600 dark:text-slate-300">This creates an approval request ticket. A manager is not automatically notified.</p><label className="block text-sm">What needs approval?<input className="field mt-2" value={approvalTitle} onChange={event => setApprovalTitle(event.target.value)} maxLength={200} required disabled={busy} /></label><label className="block text-sm">Reason and details<textarea className="field mt-2" value={approvalDescription} onChange={event => setApprovalDescription(event.target.value)} rows={4} maxLength={4000} required disabled={busy} /></label>{error && <p role="alert" className="text-sm text-rose-700">{error}</p>}<div className="flex justify-end gap-2"><button type="button" className="secondary-button" disabled={busy} onClick={() => setApprovalOpen(false)}>Cancel</button><button className="primary-button" disabled={busy || !approvalTitle.trim() || !approvalDescription.trim()}><Send size={16} />{busy ? 'Submitting...' : 'Submit approval request'}</button></div></form></Modal>}
          {assignOpen && <Modal title="Assign chat" onClose={() => { if (!busy) setAssignOpen(false) }}><form className="space-y-4 p-5" onSubmit={event => void assignChat(event)}>
            <label className="block text-sm">Online IT team member<select className="field mt-2" value={assignTo} onChange={event => setAssignTo(event.target.value)} disabled={busy || agents.loading || !!agents.error} required><option value="">Select an online member</option>{agents.data?.items.filter(agent => agent.id !== selected.primaryOwner?.id).map(agent => <option key={agent.id} value={agent.id}>{agent.fullName}</option>)}</select></label>
            {agents.loading && <p role="status" className="text-sm">Loading online members...</p>}
            {agents.error && <p role="alert" className="text-sm text-rose-700">{agents.error}</p>}
            {agents.data && !agents.data.items.some(agent => agent.id !== selected.primaryOwner?.id) && <p role="status" className="text-sm">No other IT team members are online.</p>}
            {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
            <div className="flex justify-end gap-2"><button type="button" className="secondary-button" disabled={busy} onClick={() => setAssignOpen(false)}>Cancel</button><button className="primary-button" disabled={busy || !assignTo || !agents.data?.items.some(agent => agent.id === assignTo)}>{busy ? 'Assigning...' : 'Assign chat'}</button></div>
          </form></Modal>}
        </> : <><div className="chat-mobile-back border-b px-3 py-2"><button type="button" className="secondary-button" disabled={busy} onClick={showConversationList}><ArrowLeft size={16} />Back to conversations</button></div><div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-slate-500"><span className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 text-brand-600 dark:bg-blue-950 dark:text-blue-300"><MessageCircle size={22} /></span>{startingChat && newParticipants.length > 0 && <p role="status" className="font-semibold text-slate-800 dark:text-slate-100">New chat with {newParticipants.map(person => person.fullName).join(', ')}</p>}<p className="max-w-60 leading-6">{startingChat ? newParticipants.length > 0 ? 'Write and send your first message to create this chat.' : 'Select people and write a message to start a chat.' : 'Select an existing conversation or use + to start a chat.'}</p>{options.data?.allowNewChats === false && <p>New chats are currently unavailable.</p>}</div></>}
        {startingChat && newParticipants.length > 0 && <div className="flex flex-wrap gap-2 border-t px-3 py-2 text-xs"><span>People to add:</span>{newParticipants.map(person => <button type="button" key={person.id} className="rounded border px-2" disabled={busy} onClick={() => setNewParticipants(current => current.filter(item => item.id !== person.id))} aria-label={`Remove ${person.fullName}`}>{person.fullName} ×</button>)}</div>}
        {selected && <div role="group" aria-label="Chat actions" className="flex items-center gap-2 border-t border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
          {staff && <button type="button" className="secondary-button px-3 py-1.5 text-xs" disabled={busy || uncertain} onClick={() => { setError(''); setApprovalOpen(true) }}>Approval</button>}
          {staff && selected.status === 'open' && <button type="button" className="secondary-button px-3 py-1.5 text-xs" disabled={busy || uncertain} onClick={() => { setError(''); setAssignTo(''); setAssignOpen(true) }}>Assign</button>}
          {selected.status === 'closed'
            ? <button type="button" className="secondary-button px-3 py-1.5 text-xs" disabled={busy || uncertain} onClick={() => void changeChannelStatus(selected, 'reopen')}>Reopen</button>
            : <>
              {(me.data?.role === 'employee' || ['it_team', 'super_admin'].includes(me.data?.role || '')) && <button type="button" className="secondary-button px-3 py-1.5 text-xs" disabled={busy || uncertain} onClick={() => void changeChannelStatus(selected, 'close')}>Close</button>}
            </>}
        </div>}
        <div className="relative">
          {participantsOpen && <section id="chat-participant-picker" aria-label="Add person to chat" className="absolute bottom-full right-2 z-20 mb-1 w-[min(24rem,calc(100%-1rem))] rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-xl dark:border-slate-700 dark:bg-slate-900" onKeyDown={event => { if (event.key === 'Escape' && !busy) setParticipantsOpen(false) }}>
            <div className="space-y-2">
              <input aria-label="Search users" type="search" autoFocus autoComplete="off" className="field" placeholder="Search name or employee ID" value={participantSearch} maxLength={100} disabled={busy} onChange={event => { setParticipantSearch(event.target.value); setParticipantPage(1); setParticipantResults({ key: '', items: [] }) }} />
              <div role="region" aria-label="User search results" tabIndex={0} className="max-h-40 space-y-1 overflow-y-auto" onScroll={event => {
                const list = event.currentTarget
                if (!searchPending && !participants.loading && !participants.error && participants.data?.hasMore && list.scrollTop + list.clientHeight >= list.scrollHeight - 24) setParticipantPage(page => page + 1)
              }}>{displayedParticipants.map(person => {
                const pending = startingChat && newParticipants.some(item => item.id === person.id)
                return <button key={person.id} type="button" disabled={person.isMember || busy || (startingChat && !pending && newParticipants.length >= 50)} className="block w-full rounded-md border p-2 text-left text-sm hover:bg-blue-50 disabled:opacity-60 dark:hover:bg-slate-800" onClick={() => void addParticipant(person)}>{person.fullName}{person.isMember ? ' · Already in chat' : pending ? ' · Selected' : ''}</button>
              })}</div>
              {(searchPending || participants.loading) && <p role="status">Loading users...</p>}
              {participants.error && <p role="alert">{participants.error} <button type="button" className="underline" onClick={() => setParticipantRevision(value => value + 1)}>Retry loading users</button></p>}
              {participants.data && !searchPending && displayedParticipants.length === 0 && <p role="status">{participantSearch.trim() ? 'No matching authorized users.' : 'No users available.'}</p>}
              {startingChat && newParticipants.length >= 50 && <p role="status">Maximum of 50 people selected.</p>}
            </div>
          </section>}
          <form className="flex items-end gap-2 border-t border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900" onSubmit={event => { event.preventDefault(); void send() }}><textarea ref={composer} aria-label="Message" placeholder="Write a message" autoComplete="off" className="field chat-composer min-w-0 flex-1 resize-none rounded-2xl px-4 py-2.5 text-sm" rows={1} value={draft} maxLength={4000} disabled={cannotSend} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void send() } }} /><button type="button" className="icon-button h-10 w-10 shrink-0" title="Start new chat" aria-label="Start new chat" aria-expanded={participantsOpen} aria-controls="chat-participant-picker" disabled={busy || uncertain || !channels.data || options.data?.allowNewChats !== true} onClick={() => { if (!startingChat) { startNewChat(); return } setError(''); setParticipantPage(1); setParticipantSearch(''); setParticipantResults({ key: '', items: [] }); setParticipantsOpen(open => !open) }}><Plus size={18} /></button><button className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50" title="Send message" aria-label="Send message" disabled={cannotSend || !draft.trim()}><Send size={17} /></button></form>
        </div>
      </main>
    </div>
  </div>
}