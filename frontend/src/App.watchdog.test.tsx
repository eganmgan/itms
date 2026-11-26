import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

vi.mock('./components/ChatAssistant', () => ({ ChatAssistant: () => null }))
vi.mock('./pages/DeviceOverviewPage', () => ({ DeviceOverviewPage: ({ assetId, pathname }: { assetId?: string; pathname?: string }) => <h1>Device {assetId} {pathname}</h1> }))
vi.mock('./manual-entry/ManualEntryPage', () => ({ ManualEntryPage: ({ watchdogRoute, chatRoute }: { watchdogRoute?: boolean; chatRoute?: boolean }) => <h1>{watchdogRoute ? 'Watchdog fixture' : chatRoute ? 'Chat settings fixture' : 'Settings fixture'}</h1> }))

describe('Watchdog and device direct routes', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('itms_token', 'route-fixture')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ role: 'super_admin', sections: ['devices', 'patch', 'security', 'employee', 'gatepass'], readOnly: false, customized: false }), { headers: { 'Content-Type': 'application/json' } })))
  })
  afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/') })
  it.each([['/settings/watchdog', 'Watchdog fixture'], ['/settings/chat', 'Chat settings fixture']])('opens %s directly', async (path, heading) => {
    window.history.replaceState({}, '', path)
    render(<App />)
    expect(await screen.findByRole('heading', { name: heading })).toBeVisible()
  })
  it.each(['', '/alerts', '/apps', '/applications', '/services', '/history'])('opens a device %s without a previous directory selection', async tab => {
    const assetId = '11111111-1111-4111-8111-111111111111'
    const path = `/devices/${assetId}${tab}`
    window.history.replaceState({}, '', path)
    render(<App />)
    expect(await screen.findByRole('heading', { name: `Device ${assetId} ${path}` })).toBeVisible()
  })
  it('rejects unknown device tabs', async () => {
    window.history.replaceState({}, '', '/devices/11111111-1111-4111-8111-111111111111/unsupported')
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Page unavailable' })).toBeVisible()
  })
})