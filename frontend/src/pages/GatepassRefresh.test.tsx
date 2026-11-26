import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GatepassPage } from './GatepassPage'

vi.mock('jsbarcode', () => ({ default: vi.fn() }))
vi.mock('../lib/exports', () => ({ exportCsv: vi.fn(), exportElementPdf: vi.fn() }))

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.setItem('itms_token', 'fixture-token')
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('refreshes every 60 seconds but does not interrupt an open draft', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(
    String(url).includes('/options') ? { items: [] } : String(url).includes('/audit') ? [] : { items: [] },
  ), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  render(<GatepassPage />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(screen.queryByText('Live API')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument()
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(fetchMock).toHaveBeenCalledTimes(4)
  fireEvent.click(screen.getByRole('button', { name: 'Create Gatepass' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(fetchMock).toHaveBeenCalledTimes(5)
  const dialog = screen.getByRole('dialog')
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
  expect(fetchMock).toHaveBeenCalledTimes(5)
  expect(dialog).toBeVisible()
})
