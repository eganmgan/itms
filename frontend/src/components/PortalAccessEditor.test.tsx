import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PortalAccessEditor } from './PortalAccessEditor'
import { parsePortalAccess } from '../lib/portalAccess'

beforeEach(() => { localStorage.clear(); localStorage.setItem('itms_token', 'portal-test') })
afterEach(() => vi.unstubAllGlobals())
it('saves selected sections separately from the user role and restores defaults', async () => {
  const access = { role: 'employee', sections: ['devices', 'security', 'employee'], readOnly: false, customized: false }
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(access), { headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  render(<PortalAccessEditor userId="employee-1" token="portal-test" />)
  fireEvent.click(await screen.findByRole('checkbox', { name: 'patch' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save sections' }))
  await screen.findByText('Portal sections saved.')
  expect(fetchMock).toHaveBeenCalledWith('/api/users/employee-1/portal-access', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ sections: ['devices', 'security', 'employee', 'patch'] }) }))
  fireEvent.click(screen.getByRole('button', { name: 'Role defaults' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/users/employee-1/portal-access', expect.objectContaining({ body: JSON.stringify({ useDefaults: true }) })))
})
it('fails closed on malformed permission data and retains auditor read-only status', () => {
  expect(() => parsePortalAccess({ role: 'employee', sections: ['settings'] })).toThrow()
  expect(parsePortalAccess({ role: 'auditor', sections: [], readOnly: false, customized: true }).readOnly).toBe(true)
})
it('does not allow a denied permissions read to enable saving', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })))
  render(<PortalAccessEditor userId="employee-1" token="portal-test" />)
  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: 'Save sections' })).toBeDisabled()
})

it('ignores a previous employee save after switching employees', async () => {
  let finishSave!: (response: Response) => void
  let saveSignal: AbortSignal | null | undefined
  const access = { role: 'employee', sections: ['devices'], readOnly: false, customized: false }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      saveSignal = init.signal
      return new Promise<Response>(resolve => { finishSave = resolve })
    }
    return new Response(JSON.stringify({ ...access, sections: String(input).includes('employee-2') ? ['security'] : ['devices'] }))
  }))
  const mounted = render(<PortalAccessEditor userId="employee-1" token="portal-test" />)
  await screen.findByRole('checkbox', { name: 'devices' })
  fireEvent.click(screen.getByRole('button', { name: 'Save sections' }))
  mounted.rerender(<PortalAccessEditor userId="employee-2" token="portal-test" />)
  expect(await screen.findByRole('checkbox', { name: 'security' })).toBeChecked()
  expect(saveSignal?.aborted).toBe(true)
  await act(async () => finishSave(new Response(JSON.stringify(access))))
  expect(screen.getByRole('checkbox', { name: 'security' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'devices' })).not.toBeChecked()
  expect(screen.queryByText('Portal sections saved.')).not.toBeInTheDocument()
})