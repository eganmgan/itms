import { useEffect, useState } from 'react'

type MattermostMessage = {
  postId: string
  channelName: string
  userName: string
  message: string
  postedAt: string
}

const apiBase = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseMattermostMessages(payload: unknown): MattermostMessage[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) throw new Error('Invalid Mattermost history response.')
  return payload.items.map(item => {
    if (!isRecord(item) ||
      typeof item.postId !== 'string' ||
      typeof item.channelName !== 'string' ||
      typeof item.userName !== 'string' ||
      typeof item.message !== 'string' ||
      typeof item.postedAt !== 'string') {
      throw new Error('Invalid Mattermost history message.')
    }
    return {
      postId: item.postId,
      channelName: item.channelName,
      userName: item.userName,
      message: item.message,
      postedAt: item.postedAt,
    }
  })
}

export function MattermostFeed({ token }: { token: string }) {
  const [messages, setMessages] = useState<MattermostMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    let timer: number | undefined
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const response = await fetch(`${apiBase}/integrations/mattermost/messages?limit=100`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
          signal: controller.signal,
        })
        const payload: unknown = await response.json().catch(() => ({}))
        if (!response.ok) {
          const message = isRecord(payload) && typeof payload.error === 'string'
            ? payload.error
            : `Mattermost history request failed (${response.status})`
          throw new Error(message)
        }
        const items = parseMattermostMessages(payload)
        if (active) setMessages(items)
      } catch (requestError) {
        if (active && !controller.signal.aborted) {
          setError(requestError instanceof Error ? requestError.message : 'Mattermost history is unavailable.')
        }
      } finally {
        if (active) {
          setLoading(false)
          timer = window.setTimeout(() => void load(), 15_000)
        }
      }
    }
    void load()
    return () => {
      active = false
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [token, refreshKey])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2 text-xs text-slate-500">
        <span>Read-only copy; refreshes every 15 seconds.</span>
        <button type="button" className="font-semibold text-brand-600 underline disabled:opacity-50" onClick={() => setRefreshKey(value => value + 1)} disabled={loading}>
          Refresh
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {error && <p className="mb-3 rounded bg-rose-50 p-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300" role="alert">{error}</p>}
        {loading && messages.length === 0 && <p className="text-sm text-slate-500" role="status">Loading Mattermost history...</p>}
        {!loading && !error && messages.length === 0 && <p className="text-sm text-slate-500" role="status">No Mattermost messages have been synced yet.</p>}
        <ol className="space-y-3" aria-label="Recent Mattermost messages">
          {messages.map(item => (
            <li key={item.postId} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-sm font-semibold text-slate-900 dark:text-white">{item.userName}</span>
                <span className="text-xs text-slate-500">#{item.channelName}</span>
                <time className="ml-auto text-[11px] text-slate-500" dateTime={item.postedAt}>{new Date(item.postedAt).toLocaleString()}</time>
              </div>
              <p className="whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-200">
                {item.message || 'Non-text post; open Mattermost to view attachments.'}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  )
}
