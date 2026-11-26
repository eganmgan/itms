import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SSHTerminal } from './SSHTerminal'

const emulator = vi.hoisted(() => ({ terminals: [] as MockTerminal[], fits: [] as { fit: ReturnType<typeof vi.fn> }[], failAddon: false }))

interface MockTerminal {
  options: { disableStdin: boolean }
  cols: number
  rows: number
  write: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  inputDispose: ReturnType<typeof vi.fn>
  resizeDispose: ReturnType<typeof vi.fn>
  input: (data: string) => void
  resize: (size: { cols: number; rows: number }) => void
}

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: { disableStdin: boolean }
    cols = 100
    rows = 28
    write = vi.fn()
    focus = vi.fn()
    dispose = vi.fn()
    inputDispose = vi.fn()
    resizeDispose = vi.fn()
    input = (_data: string) => {}
    resize = (_size: { cols: number; rows: number }) => {}
    constructor(options: { disableStdin: boolean }) { this.options = options; emulator.terminals.push(this) }
    loadAddon() {}
    open(host: HTMLElement) { host.appendChild(document.createElement('textarea')) }
    onData(callback: (data: string) => void) { this.input = callback; return { dispose: this.inputDispose } }
    onResize(callback: (size: { cols: number; rows: number }) => void) { this.resize = callback; return { dispose: this.resizeDispose } }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
    constructor() {
      if (emulator.failAddon) throw new Error('Terminal addon unavailable')
      emulator.fits.push(this)
    }
  },
}))

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static instances: MockWebSocket[] = []
  readyState = 0
  bufferedAmount = 0
  url: string
  protocols: string[]
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 3 })
  constructor(url: string, protocols: string[]) { this.url = url; this.protocols = protocols; MockWebSocket.instances.push(this) }
  open() { this.readyState = 1; this.onopen?.() }
  message(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }) }
}

class MockResizeObserver {
  static instances: MockResizeObserver[] = []
  callback: () => void
  observe = vi.fn()
  disconnect = vi.fn()
  constructor(callback: () => void) { this.callback = callback; MockResizeObserver.instances.push(this) }
}

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let fetchMock: ReturnType<typeof vi.fn>
const currentSocket = () => MockWebSocket.instances.at(-1)!
const currentTerminal = () => emulator.terminals.at(-1)!
const flush = async () => { await act(async () => { await Promise.resolve() }) }
async function mount() {
  const view = render(<SSHTerminal assetId="asset-1" systemId="host-1" />)
  await flush()
  return view
}
function becomeReady() {
  act(() => { currentSocket().open(); currentSocket().message({ type: 'ready', message: 'Connected to operator@host-1:22' }) })
}

describe('SSHTerminal', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    emulator.terminals.length = 0
    emulator.fits.length = 0
    emulator.failAddon = false
    MockWebSocket.instances = []
    MockResizeObserver.instances = []
    localStorage.setItem('itms_token', 'test-token')
    fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response({ sessionId: 'session-1' })))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('authenticates session creation and the WebSocket without putting credentials in the URL', async () => {
    await mount()
    expect(fetchMock).toHaveBeenCalledWith('/api/ssh/session', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ deviceId: 'asset-1' }),
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, signal: expect.any(AbortSignal),
    }))
    const url = new URL(currentSocket().url)
    expect(url.protocol).toBe('ws:')
    expect(url.host).toBe(window.location.host)
    expect(url.pathname).toBe('/ws/ssh/assets/asset-1')
    expect(url.searchParams.get('sessionId')).toBe('session-1')
    expect(url.searchParams.has('token')).toBe(false)
    expect(currentSocket().url).not.toContain('test-token')
    expect(currentSocket().protocols).toEqual(['itms.ssh.v1', 'bearer.dGVzdC10b2tlbg'])
  })

  it('waits for ready, streams ANSI output unchanged, and sends raw keys without local echo', async () => {
    await mount()
    act(() => { currentSocket().open(); currentTerminal().input('ignored') })
    expect(screen.getByRole('status')).toHaveTextContent('Connecting')
    expect(currentTerminal().options.disableStdin).toBe(true)
    expect(currentSocket().send).not.toHaveBeenCalled()
    becomeReady()
    expect(screen.getByRole('status')).toHaveTextContent('Ready')
    expect(currentTerminal().options.disableStdin).toBe(false)
    expect(currentTerminal().focus).toHaveBeenCalledOnce()
    expect(currentSocket().send).toHaveBeenCalledWith(JSON.stringify({ type: 'resize', cols: 100, rows: 28 }))
    for (const data of ['ls', '\r', '\u0003', '\u001b[A', '\u007f', '\t', 'pasted\ntext']) {
      act(() => currentTerminal().input(data))
      expect(currentSocket().send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'input', data }))
    }
    expect(currentTerminal().write).not.toHaveBeenCalled()
    const output = '\u001b[32mhello\u001b[0m\r\n$ '
    act(() => currentSocket().message({ type: 'output', data: output }))
    expect(currentTerminal().write).toHaveBeenCalledWith(output)
    act(() => vi.advanceTimersByTime(30_001))
    expect(screen.getByRole('status')).toHaveTextContent('Ready')
  })

  it('splits large paste safely below the backend frame limit without losing Unicode', async () => {
    await mount()
    becomeReady()
    currentSocket().send.mockClear()
    const data = 'a'.repeat(2047) + '😀' + '\u0000'.repeat(15_000)
    act(() => currentTerminal().input(data))
    const frames = currentSocket().send.mock.calls.map(([frame]) => String(frame))
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.every(frame => new TextEncoder().encode(frame).length < 64 * 1024)).toBe(true)
    expect(frames.map(frame => JSON.parse(frame).data).join('')).toBe(data)
    expect(JSON.parse(frames[0]).data).toBe('a'.repeat(2047))
  })

  it('fits on container/window changes and sends PTY dimensions only when ready', async () => {
    await mount()
    expect(emulator.fits[0].fit).toHaveBeenCalled()
    act(() => currentTerminal().resize({ cols: 90, rows: 20 }))
    expect(currentSocket().send).not.toHaveBeenCalled()
    becomeReady()
    act(() => {
      MockResizeObserver.instances[0].callback()
      window.dispatchEvent(new Event('resize'))
      vi.advanceTimersByTime(20)
      currentTerminal().resize({ cols: 110, rows: 32 })
    })
    expect(emulator.fits[0].fit.mock.calls.length).toBeGreaterThan(1)
    expect(currentSocket().send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'resize', cols: 110, rows: 32 }))
  })

  it.each([401, 403, 502])('shows HTTP %s errors without opening a socket', async status => {
    fetchMock.mockResolvedValue(response({ error: 'SSH access unavailable' }, status))
    await mount()
    expect(screen.getByRole('alert')).toHaveTextContent('SSH access unavailable')
    expect(MockWebSocket.instances).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeVisible()
  })

  it('handles a proxy HTML response', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } }))
    await mount()
    expect(screen.getByRole('alert')).toHaveTextContent('temporarily unavailable')
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('requires authentication and a device', async () => {
    localStorage.clear()
    const view = await mount()
    expect(screen.getByRole('alert')).toHaveTextContent('Sign in')
    expect(fetchMock).not.toHaveBeenCalled()
    localStorage.setItem('itms_token', 'new-token')
    view.rerender(<SSHTerminal assetId="" systemId="" />)
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('Select a managed device')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('handles fetch rejection and WebSocket construction failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Network unavailable'))
    await mount()
    expect(screen.getByRole('alert')).toHaveTextContent('Network unavailable')
    vi.stubGlobal('WebSocket', class { constructor() { throw new Error('WebSocket blocked') } })
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('WebSocket blocked')
  })

  it('surfaces addon initialization failures and allows a clean retry', async () => {
    emulator.failAddon = true
    await mount()
    expect(screen.getByRole('alert')).toHaveTextContent('Terminal addon unavailable')
    expect(fetchMock).not.toHaveBeenCalled()
    emulator.failAddon = false
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await flush()
    becomeReady()
    expect(screen.getByRole('status')).toHaveTextContent('Ready')
  })

  it('surfaces asynchronous resize failures without leaving an active connection', async () => {
    await mount()
    becomeReady()
    emulator.fits[0].fit.mockImplementation(() => { throw new Error('Renderer unavailable') })
    act(() => { MockResizeObserver.instances[0].callback(); vi.advanceTimersByTime(20) })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not resize the SSH terminal')
    expect(currentSocket().close).toHaveBeenCalledOnce()
    expect(currentTerminal().options.disableStdin).toBe(true)
  })

  it('fits when a hidden container becomes visible and when the mobile viewport changes', async () => {
    const viewport = new EventTarget()
    vi.stubGlobal('visualViewport', viewport)
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(0)
    const view = await mount()
    expect(emulator.fits[0].fit).not.toHaveBeenCalled()
    width.mockReturnValue(320)
    act(() => { MockResizeObserver.instances[0].callback(); vi.advanceTimersByTime(20) })
    expect(emulator.fits[0].fit).toHaveBeenCalledOnce()
    act(() => { viewport.dispatchEvent(new Event('resize')); vi.advanceTimersByTime(20) })
    expect(emulator.fits[0].fit).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('region')).toHaveClass('min-w-0', 'max-w-full', 'overflow-hidden')
    expect(screen.getByLabelText('Interactive SSH terminal')).toHaveClass('min-w-0', 'max-w-full', 'overflow-hidden')
    view.unmount()
    act(() => { viewport.dispatchEvent(new Event('resize')); vi.advanceTimersByTime(20) })
    expect(emulator.fits[0].fit).toHaveBeenCalledTimes(2)
  })

  it('preserves backend errors after close and ignores late ready events', async () => {
    await mount()
    const socket = currentSocket()
    const lateMessage = socket.onmessage!
    act(() => { socket.open(); socket.message({ type: 'error', message: 'SSH authentication failed' }) })
    act(() => lateMessage({ data: JSON.stringify({ type: 'ready' }) }))
    expect(screen.getByRole('alert')).toHaveTextContent('SSH authentication failed')
    expect(socket.close).toHaveBeenCalledOnce()
    expect(socket.onclose).toBeNull()
    expect(currentTerminal().options.disableStdin).toBe(true)
  })

  it('reports WebSocket errors with actionable guidance', async () => {
    await mount()
    act(() => currentSocket().onerror?.())
    expect(screen.getByRole('alert')).toHaveTextContent('Check authentication, device access, and the /ws proxy')
    expect(currentSocket().close).toHaveBeenCalledOnce()
  })

  it.each([false, true])('bounds readiness when the WebSocket is open=%s', async open => {
    await mount()
    if (open) act(() => currentSocket().open())
    act(() => vi.advanceTimersByTime(30_000))
    expect(screen.getByRole('alert')).toHaveTextContent('within 30 seconds')
    expect(currentSocket().close).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('bounds a stalled HTTP request and ignores a late response', async () => {
    let resolve!: (value: Response) => void
    fetchMock.mockReturnValue(new Promise<Response>(done => { resolve = done }))
    await mount()
    act(() => vi.advanceTimersByTime(30_000))
    expect(screen.getByRole('alert')).toHaveTextContent('within 30 seconds')
    await act(async () => resolve(response({ sessionId: 'late-session' })))
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('uses one readiness budget across HTTP creation and the WebSocket handshake', async () => {
    let resolve!: (value: Response) => void
    fetchMock.mockReturnValue(new Promise<Response>(done => { resolve = done }))
    await mount()
    act(() => vi.advanceTimersByTime(20_000))
    await act(async () => resolve(response({ sessionId: 'slow-session' })))
    act(() => { currentSocket().open(); vi.advanceTimersByTime(10_000) })
    expect(screen.getByRole('alert')).toHaveTextContent('within 30 seconds')
    expect(currentSocket().close).toHaveBeenCalledOnce()
  })

  it('times out a stalled response body and ignores it after reconnecting', async () => {
    let resolveBody!: (value: object) => void
    const stalled = response({})
    vi.spyOn(stalled, 'json').mockReturnValue(new Promise<object>(resolve => { resolveBody = resolve }))
    fetchMock.mockResolvedValueOnce(stalled)
    await mount()
    act(() => vi.advanceTimersByTime(30_000))
    expect(screen.getByRole('alert')).toHaveTextContent('within 30 seconds')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await flush()
    becomeReady()
    await act(async () => resolveBody({ sessionId: 'stale-session' }))
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('Ready')
  })

  it.each([
    [false, 1000, 'before the shell was ready'],
    [true, 1000, 'SSH session closed'],
    [true, 1006, 'interrupted (code 1006)'],
  ])('handles close with ready=%s and code=%s', async (ready, code, message) => {
    await mount()
    if (ready) becomeReady()
    act(() => { currentSocket().readyState = 3; currentSocket().onclose?.({ code }) })
    expect(screen.getByRole(ready && code === 1000 ? 'status' : 'alert')).toHaveTextContent(message)
    expect(currentTerminal().options.disableStdin).toBe(true)
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeVisible()
  })

  it('handles exit and reconnects explicitly with fresh authentication', async () => {
    await mount()
    becomeReady()
    const oldTerminal = currentTerminal()
    act(() => currentSocket().message({ type: 'exit', message: 'Shell exited.' }))
    expect(screen.getByRole('status')).toHaveTextContent('Closed · Shell exited.')
    localStorage.setItem('itms_token', 'new-token')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    await flush()
    expect(oldTerminal.dispose).toHaveBeenCalledOnce()
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer new-token')
    expect(screen.getByRole('status')).toHaveTextContent('Connecting')
  })

  it.each(['not-json', 'null', '{"type":"output","data":42}', '{"type":"unknown"}'])('rejects malformed protocol data: %s', async data => {
    await mount()
    act(() => currentSocket().onmessage?.({ data }))
    expect(screen.getByRole('alert')).toHaveTextContent('invalid SSH server response')
    expect(currentSocket().close).toHaveBeenCalledOnce()
  })

  it('stops on send failure or excessive buffered input', async () => {
    await mount()
    becomeReady()
    currentSocket().bufferedAmount = 1024 * 1024 + 1
    act(() => currentTerminal().input('ls\r'))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not send terminal input')
    expect(currentSocket().close).toHaveBeenCalledOnce()
  })

  it('disconnects on authentication changes without automatically reconnecting', async () => {
    await mount()
    becomeReady()
    act(() => window.dispatchEvent(new Event('itms-auth-changed')))
    expect(screen.getByRole('status')).toHaveTextContent('Closed · Authentication changed')
    expect(currentSocket().close).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('disconnects manually and disposes all resources on unmount', async () => {
    const setTimer = vi.spyOn(globalThis, 'setTimeout')
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout')
    const view = await mount()
    const deadlineIndex = setTimer.mock.calls.findIndex(([, delay]) => delay === 30_000)
    const deadline = setTimer.mock.results[deadlineIndex].value
    becomeReady()
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    expect(screen.getByRole('status')).toHaveTextContent('Closed · Disconnected')
    const terminal = currentTerminal()
    currentSocket().send.mockClear()
    act(() => terminal.input('ignored'))
    expect(currentSocket().send).not.toHaveBeenCalled()
    view.unmount()
    expect(terminal.dispose).toHaveBeenCalledOnce()
    expect(terminal.inputDispose).toHaveBeenCalledOnce()
    expect(terminal.resizeDispose).toHaveBeenCalledOnce()
    expect(MockResizeObserver.instances[0].disconnect).toHaveBeenCalledOnce()
    expect(currentSocket().onmessage).toBeNull()
    expect(clearTimer).toHaveBeenCalledWith(deadline)
  })

  it('aborts on unmount and ignores pending session creation', async () => {
    const setTimer = vi.spyOn(globalThis, 'setTimeout')
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout')
    let resolve!: (value: Response) => void
    fetchMock.mockReturnValue(new Promise<Response>(done => { resolve = done }))
    const view = await mount()
    const deadlineIndex = setTimer.mock.calls.findIndex(([, delay]) => delay === 30_000)
    const deadline = setTimer.mock.results[deadlineIndex].value
    view.unmount()
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    await act(async () => resolve(response({ sessionId: 'stale' })))
    expect(MockWebSocket.instances).toHaveLength(0)
    expect(clearTimer).toHaveBeenCalledWith(deadline)
  })

  it('replaces the connection on asset changes and cleans up StrictMode attempts', async () => {
    const view = render(<StrictMode><SSHTerminal assetId="asset-1" systemId="host-1" /></StrictMode>)
    await flush()
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(emulator.terminals[0].dispose).toHaveBeenCalledOnce()
    const oldSocket = currentSocket()
    view.rerender(<StrictMode><SSHTerminal assetId="asset-2" systemId="host-2" /></StrictMode>)
    await flush()
    expect(oldSocket.close).toHaveBeenCalledOnce()
    expect(currentSocket().url).toContain('/ws/ssh/assets/asset-2')
    expect(screen.getByRole('region', { name: 'SSH terminal for host-2' })).toBeVisible()
  })

  it('ignores stale socket callbacks after switching devices', async () => {
    const view = await mount()
    const oldSocket = currentSocket()
    const lateMessage = oldSocket.onmessage!
    const lateError = oldSocket.onerror!
    const lateClose = oldSocket.onclose!
    view.rerender(<SSHTerminal assetId="asset-2" systemId="host-2" />)
    await flush()
    becomeReady()
    act(() => {
      lateMessage({ data: JSON.stringify({ type: 'output', data: 'old device output' }) })
      lateMessage({ data: JSON.stringify({ type: 'ready' }) })
      lateError()
      lateClose({ code: 1006 })
    })
    expect(currentTerminal().write).not.toHaveBeenCalled()
    expect(currentSocket().close).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent('Ready')
  })
})