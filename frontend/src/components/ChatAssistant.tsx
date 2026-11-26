import { MessageCircle, X } from 'lucide-react'
import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useAuthToken } from '../lib/auth'
import { ChatResizeHandle } from './ChatResizeHandle'
import { SupportChat, SupportChatInbox } from './SupportChat'

type AssistantProps = { context: string; token?: string }
type MattermostConfig = { loading: boolean; url: string; error: string }
type ChatService = 'support' | 'mattermost'

const apiBase = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

export function ChatAssistant({ token: explicitToken }: AssistantProps) {
  const storeToken = useAuthToken()
  const token = explicitToken ?? storeToken
  const [open, setOpen] = useState(false)
  const [activeService, setActiveService] = useState<ChatService>('support')
  const [mattermost, setMattermost] = useState<MattermostConfig>({ loading: false, url: '', error: '' })
  const [showRecentChats, setShowRecentChats] = useState(true)
  const [width, setWidth] = useState(720)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  useEffect(() => {
    if (!open) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open])
  useEffect(() => {
    if (!open || !token) {
      setMattermost({ loading: false, url: '', error: '' })
      return
    }

    const controller = new AbortController()
    let active = true
    const timeout = window.setTimeout(() => controller.abort(), 8000)
    setMattermost({ loading: true, url: '', error: '' })
    void (async () => {
      try {
        const response = await fetch(`${apiBase}/integrations/mattermost/embed-config`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
          signal: controller.signal,
        })
        const payload = await response.json().catch(() => ({})) as { configured?: unknown; baseUrl?: unknown; error?: unknown }
        if (!response.ok) {
          throw new Error(typeof payload.error === 'string' ? payload.error : `Mattermost configuration request failed (${response.status})`)
        }
        if (typeof payload.configured !== 'boolean') throw new Error('Invalid Mattermost configuration response.')
        if (!payload.configured) {
          if (active) setMattermost({ loading: false, url: '', error: '' })
          return
        }
        if (typeof payload.baseUrl !== 'string') throw new Error('Mattermost workspace URL is missing.')
        const url = new URL(payload.baseUrl)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
          throw new Error('Mattermost workspace URL is invalid.')
        }
        if (active) setMattermost({ loading: false, url: url.toString().replace(/\/$/, ''), error: '' })
      } catch (error) {
        if (active) setMattermost({
          loading: false,
          url: '',
          error: controller.signal.aborted ? 'Mattermost configuration request timed out.' : error instanceof Error ? error.message : 'Mattermost is unavailable.',
        })
      } finally {
        window.clearTimeout(timeout)
      }
    })()
    return () => {
      active = false
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [open, token])

  const handleServiceTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    let nextService: ChatService | undefined
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      nextService = activeService === 'support' ? 'mattermost' : 'support'
    } else if (event.key === 'Home') {
      nextService = 'support'
    } else if (event.key === 'End') {
      nextService = 'mattermost'
    }
    if (!nextService) return

    event.preventDefault()
    setActiveService(nextService)
    document.getElementById(`${nextService}-tab`)?.focus()
  }

  const workspace = (
      <div className="pointer-events-none fixed bottom-2 right-2 z-50">
        {open && <section className="pointer-events-auto relative mb-2 flex h-[min(640px,calc(100dvh-5rem))] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white font-sans shadow-2xl shadow-slate-900/20 dark:border-slate-700 dark:bg-slate-900" style={{ width: `min(${width}px, calc(100vw - 1rem))` }} aria-label="ITMS assistant">
          <ChatResizeHandle label="Resize chat width" value={Math.min(width, viewportWidth - 16)} min={Math.min(360, viewportWidth - 16)} max={Math.max(0, Math.min(1200, viewportWidth - 16))} direction={-1} onResize={setWidth} className="absolute inset-y-0 left-0 z-10 flex w-3" />
            <header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900 sm:px-5">
              <div className="flex min-w-0 shrink-0 items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-600 text-white">
                  <MessageCircle size={18} />
                </span>
                <div className="min-w-0">
                  <h2 className="text-sm font-bold tracking-tight text-slate-900 dark:text-white">Chat</h2>
                  <p className="hidden text-xs text-slate-500 sm:block">ITMS Support and Mattermost</p>
                </div>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <div role="tablist" aria-label="Chat service" className="flex min-w-0 items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
                  <button
                    id="support-tab"
                    type="button"
                    role="tab"
                    aria-selected={activeService === 'support'}
                    aria-controls="support-panel"
                    tabIndex={activeService === 'support' ? 0 : -1}
                    onClick={() => setActiveService('support')}
                    onKeyDown={handleServiceTabKeyDown}
                    className={`whitespace-nowrap rounded-md px-3 py-2 text-xs font-medium transition ${activeService === 'support' ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'}`}
                  >
                    ITMS Support
                  </button>
                  <button
                    id="mattermost-tab"
                    type="button"
                    role="tab"
                    aria-selected={activeService === 'mattermost'}
                    aria-controls="mattermost-panel"
                    tabIndex={activeService === 'mattermost' ? 0 : -1}
                    onClick={() => setActiveService('mattermost')}
                    onKeyDown={handleServiceTabKeyDown}
                    className={`whitespace-nowrap rounded-md px-3 py-2 text-xs font-medium transition ${activeService === 'mattermost' ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white' : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'}`}
                  >
                    Mattermost
                  </button>
                </div>
                <button type="button" className="icon-button shrink-0" onClick={() => setOpen(false)} aria-label="Close assistant">
                  <X size={18} />
                </button>
              </div>
            </header>
            <div className="flex min-h-0 flex-1 flex-col">
              <section id="support-panel" role="tabpanel" aria-labelledby="support-tab" aria-label="ITMS Support" tabIndex={0} hidden={activeService !== 'support'} className={activeService === 'support' ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'hidden'}>
                <SupportChat key={token} token={token} showRecentChats={showRecentChats} onShowRecentChatsChange={setShowRecentChats} />
              </section>
              <section id="mattermost-panel" role="tabpanel" aria-labelledby="mattermost-tab" aria-label="Mattermost" tabIndex={0} hidden={activeService !== 'mattermost'} className={activeService === 'mattermost' ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : 'hidden'}>
                {!token
                  ? <div className="flex min-h-0 flex-1 items-center justify-center p-5 text-center text-sm text-slate-500" role="status">Sign in to view Mattermost.</div>
                  : mattermost.url
                    ? <iframe title="Mattermost workspace" src={mattermost.url} className="min-h-0 flex-1 border-0 bg-white" referrerPolicy="strict-origin-when-cross-origin" allow="clipboard-read; clipboard-write" />
                    : <div className="flex min-h-0 flex-1 items-center justify-center p-5 text-center text-sm text-slate-500" role={mattermost.error ? 'alert' : 'status'}>
                      {mattermost.loading ? 'Checking Mattermost configuration...' : mattermost.error || 'Mattermost embedding is not configured.'}
                    </div>}
              </section>
            </div>
          </section>
        }
        {!open && <button type="button" onClick={() => setOpen(true)} className="pointer-events-auto fixed bottom-4 right-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-white shadow-lg transition hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600" aria-label="Open ITMS assistant" title="Chat">
          <MessageCircle size={22} />
        </button>}
      </div>
  )

  return token
    ? <SupportChatInbox key={token} token={token} onActivity={() => { setActiveService('support'); setOpen(true) }}>{workspace}</SupportChatInbox>
    : workspace
}
