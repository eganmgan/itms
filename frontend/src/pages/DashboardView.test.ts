import { createElement } from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeTrendBuckets } from '../lib/dashboard'
import { DashboardView } from './DashboardView'

vi.mock('react-chartjs-2', () => ({
  Chart: ({ data }: { data: unknown }) => createElement('pre', { 'data-testid': 'operations-chart' }, JSON.stringify(data)),
  Doughnut: () => createElement('div', { 'data-testid': 'device-chart' }),
}))

describe('Dashboard production metrics', () => {
  beforeEach(() => { localStorage.setItem('itms_token', 'fixture-token') })
  afterEach(() => { localStorage.clear(); vi.unstubAllGlobals() })

  it('shows unavailable metrics rather than a healthy score or zero endpoints on API failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Dashboard unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } })))
    render(createElement(DashboardView))
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load: devices, patches, security, gatepasses, activity, profile')
    expect(screen.queryByText('100 / 100')).not.toBeInTheDocument()
    expect(screen.queryByText('0 Endpoints')).not.toBeInTheDocument()
    expect(screen.queryByText('API synchronized')).not.toBeInTheDocument()
    expect(screen.queryByTestId('operations-chart')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('uses recorded findings and does not invent patch execution history or zero-device compliance', async () => {
    const payloads: Record<string, unknown> = {
      '/api/devices/directory': { summary: { all: 0, flagged: 0 }, users: [] },
      '/api/patch/dashboard': { total: 0, upToDate: 0, pending: 0, failed: 0, rebootPending: 0 },
      '/api/alerts/dashboard': { systems: [{ status: 'error' }], trend: { dailyBuckets: [{ date: '2026-10-05', count: 2 }] } },
      '/api/gatepass': [], '/api/audit': [], '/api/me/profile': { full_name: 'Fixture User' },
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(payloads[String(input)]), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    render(createElement(DashboardView))
    await screen.findByText('No evaluated systems')
    expect(screen.getByText('Systems With Findings').closest('article')).toHaveTextContent('1')
    expect(screen.queryByText('Security Health Index')).not.toBeInTheDocument()
    expect(screen.getByTestId('operations-chart')).toHaveTextContent('"data":[2]')
    expect(screen.getByTestId('operations-chart')).not.toHaveTextContent('Salt Patch Executions')
    expect(screen.getByText('No evaluated systems')).toBeVisible()
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
  })
})

describe('normalizeTrendBuckets', () => {
  it('normalizes malformed API buckets without crashing the dashboard', () => {
    expect(normalizeTrendBuckets([
      { date: '2026-08-11', count: 4 },
      { count: 2 },
      null,
      { date: '', count: Number.NaN },
    ])).toEqual([
      { date: '2026-08-11', count: 4 },
      { date: 'Day 2', count: 2 },
      { date: 'Day 3', count: 0 },
      { date: 'Day 4', count: 0 },
    ])
  })

  it('returns no buckets for a missing trend payload', () => {
    expect(normalizeTrendBuckets(undefined)).toEqual([])
  })
})