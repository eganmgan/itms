import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { readJson } from '../lib/api'

type ConnectionState = 'connecting' | 'ready' | 'error' | 'closed'
type Connection = { state: ConnectionState; message: string }

const READY_TIMEOUT_MS = 30_000

export function SSHTerminal({ assetId, systemId }: { assetId: string; systemId: string }) {
  const container = useRef<HTMLDivElement>(null)
  const disconnect = useRef<() => void>(() => {})
  const [attempt, setAttempt] = useState(0)
  const [connection, setConnection] = useState<Connection>({ state: 'connecting', message: 'Starting SSH session…' })

  useEffect(() => {
    const host = container.current
    if (!host) return

    let disposed = false
    let ended = false
    let ready = false
    let socket: WebSocket | undefined
    let terminal: Terminal | undefined
    let fitAddon: FitAddon | undefined
    let observer: ResizeObserver | undefined
    let frame: number | undefined
    let inputSubscription: { dispose(): void } | undefined
    let resizeSubscription: { dispose(): void } | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()

    const closeSocket = () => {
      if (!socket) return
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    }
    const finish = (state: 'error' | 'closed', message: string) => {
      if (disposed || ended) return
      ended = true
      ready = false
      clearTimeout(deadline)
      controller.abort()
      if (terminal) terminal.options.disableStdin = true
      closeSocket()
      setConnection({ state, message })
    }
    const send = (message: object) => {
      if (!ready || ended || disposed || socket?.readyState !== WebSocket.OPEN) return
      try {
        // Do not allow an unresponsive connection to accumulate unbounded input.
        if (socket.bufferedAmount > 1024 * 1024) throw new Error('SSH connection is not keeping up with input. Reconnect to continue.')
        socket.send(JSON.stringify(message))
      } catch {
        finish('error', 'Could not send terminal input. The connection may be interrupted; reconnect to continue.')
      }
    }

    const fit = () => {
      if (disposed || !terminal || host.clientWidth === 0 || host.clientHeight === 0) return
      try {
        fitAddon?.fit()
      } catch {
        finish('error', 'Could not resize the SSH terminal. Reconnect to initialize the console again.')
      }
    }
    const scheduleFit = () => {
      if (disposed) return
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => { frame = undefined; fit() })
    }
    const authChanged = () => finish('closed', 'Authentication changed. Reconnect with your current account.')
    disconnect.current = () => finish('closed', 'Disconnected from SSH.')
    setConnection({ state: 'connecting', message: 'Starting SSH session…' })
    deadline = setTimeout(() => finish('error', 'SSH did not become ready within 30 seconds. Check the device, SSH configuration, and WebSocket proxy, then reconnect.'), READY_TIMEOUT_MS)
    window.addEventListener('resize', scheduleFit)
    window.visualViewport?.addEventListener('resize', scheduleFit)
    window.addEventListener('itms-auth-changed', authChanged)

    const connect = async () => {
      try {
        fitAddon = new FitAddon()
        terminal = new Terminal({
          cursorBlink: true,
          disableStdin: true,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: 14,
          lineHeight: 1.2,
          scrollback: 5000,
          screenReaderMode: true,
          theme: { background: '#020617', foreground: '#e2e8f0', cursor: '#38bdf8', selectionBackground: '#334155' },
        })
        terminal.loadAddon(fitAddon)
        terminal.open(host)
        fit()
        if (ended) return
        inputSubscription = terminal.onData(data => {
          // xterm supplies raw control sequences, including Enter, arrows, and paste.
          // Bound each JSON frame below the backend's 64 KiB read limit, even
          // for escaped control characters. Never split a UTF-16 surrogate pair.
          for (let start = 0; start < data.length && !ended && !disposed;) {
            let end = Math.min(start + 2048, data.length)
            if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--
            send({ type: 'input', data: data.slice(start, end) })
            start = end
          }
        })
        resizeSubscription = terminal.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }))
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(scheduleFit)
          observer.observe(host)
        }
        void document.fonts?.ready.then(scheduleFit, () => {})

        const token = localStorage.getItem('itms_token')?.trim()
        if (!token) throw new Error('Sign in to your ITMS account before opening SSH.')
        if (!assetId.trim()) throw new Error('Select a managed device before opening SSH.')
        const response = await fetch('/api/ssh/session', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: assetId }),
          signal: controller.signal,
        })
        if (disposed || ended) return
        const payload = await readJson<{ sessionId?: string; error?: string }>(response)
        if (disposed || ended) return
        if (!response.ok) throw new Error(payload?.error || `SSH session request failed (HTTP ${response.status}).`)
        const url = new URL(`/ws/ssh/assets/${encodeURIComponent(assetId)}`, window.location.href)
        url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        if (typeof payload?.sessionId === 'string' && payload.sessionId) url.searchParams.set('sessionId', payload.sessionId)
        // The backend reads base64url bearer credentials from subprotocols,
        // not the URL (which may be recorded in proxy/access logs).
        const bearer = btoa(token).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        socket = new WebSocket(url.toString(), ['itms.ssh.v1', `bearer.${bearer}`])
        socket.onopen = () => {
          if (!ended && !disposed) setConnection({ state: 'connecting', message: 'WebSocket connected. Waiting for the SSH shell…' })
        }
        socket.onmessage = event => {
          if (ended || disposed) return
          try {
            if (typeof event.data !== 'string') throw new Error('Invalid frame')
            const message: unknown = JSON.parse(event.data)
            if (!message || typeof message !== 'object' || !('type' in message)) throw new Error('Invalid envelope')
            const envelope = message as { type: unknown; data?: unknown; message?: unknown }
            const detail = typeof envelope.message === 'string' ? envelope.message : ''
            switch (envelope.type) {
              case 'ready':
                if (ready) return
                clearTimeout(deadline)
                ready = true
                terminal!.options.disableStdin = false
                setConnection({ state: 'ready', message: detail || 'SSH shell ready.' })
                fit()
                if (ended) return
                send({ type: 'resize', cols: terminal!.cols, rows: terminal!.rows })
                if (!ended) terminal!.focus()
                break
              case 'output':
                if (typeof envelope.data !== 'string') throw new Error('Invalid output')
                terminal!.write(envelope.data)
                break
              case 'error':
                finish('error', detail || 'The SSH server reported an error.')
                break
              case 'exit':
                finish('closed', detail || 'SSH session closed.')
                break
              default:
                throw new Error('Unknown SSH message')
            }
          } catch {
            finish('error', 'Received an invalid SSH server response. Reconnect or contact your administrator.')
          }
        }
        socket.onerror = () => finish('error', 'SSH WebSocket connection failed. Check authentication, device access, and the /ws proxy.')
        socket.onclose = event => {
          if (!ready) finish('error', 'SSH connection closed before the shell was ready. Check authentication and server SSH configuration.')
          else if (event.code === 1000) finish('closed', 'SSH session closed.')
          else finish('error', `SSH connection was interrupted (code ${event.code}). Reconnect to continue.`)
        }
      } catch (error) {
        if (!disposed && !ended) finish('error', error instanceof Error ? error.message : 'Could not start SSH terminal.')
      }
    }
    void connect()

    return () => {
      disposed = true
      clearTimeout(deadline)
      controller.abort()
      disconnect.current = () => {}
      closeSocket()
      window.removeEventListener('resize', scheduleFit)
      window.visualViewport?.removeEventListener('resize', scheduleFit)
      window.removeEventListener('itms-auth-changed', authChanged)
      observer?.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
      inputSubscription?.dispose()
      resizeSubscription?.dispose()
      terminal?.dispose()
      host.replaceChildren()
    }
  }, [assetId, attempt])

  const active = connection.state === 'connecting' || connection.state === 'ready'
  return (
    <section aria-label={`SSH terminal for ${systemId}`} className="min-w-0 max-w-full overflow-hidden rounded-lg border border-slate-700 bg-slate-950 text-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
        <div className="min-w-0 max-w-full flex-1 basis-48">
          <p className="truncate font-mono text-sm font-semibold">{systemId || assetId}</p>
          <p role="status" className="mt-1 break-words text-xs text-slate-300">
            <span className={connection.state === 'ready' ? 'text-emerald-400' : connection.state === 'error' ? 'text-rose-400' : 'text-sky-300'}>
              {{ connecting: 'Connecting', ready: 'Ready', error: 'Error', closed: 'Closed' }[connection.state]}
            </span>
            {connection.state !== 'error' && ` · ${connection.message}`}
          </p>
        </div>
        <button type="button" className="rounded border border-slate-600 px-3 py-1.5 text-xs font-semibold hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400" onClick={() => active ? disconnect.current() : setAttempt(value => value + 1)}>
          {active ? 'Disconnect' : 'Reconnect'}
        </button>
      </div>
      {connection.state === 'error' && <p role="alert" className="break-words border-b border-rose-900 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">{connection.message}</p>}
      <div className="min-w-0 p-2 sm:p-3">
        <div ref={container} aria-label="Interactive SSH terminal" className="min-w-0 max-w-full overflow-hidden" style={{ height: 'clamp(240px, 50dvh, 640px)', width: '100%' }} />
      </div>
      <p className="border-t border-slate-800 px-4 py-2 text-xs text-slate-400">Live shell · Input is sent directly to the device. Ctrl+C interrupts; exit ends the session.</p>
    </section>
  )
}