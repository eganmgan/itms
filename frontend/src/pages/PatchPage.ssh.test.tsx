import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PatchPage } from './PatchPage'

vi.mock('../components/SSHTerminal', () => ({
  SSHTerminal: ({ assetId, systemId }: { assetId: string; systemId: string }) => <div data-testid="ssh-terminal" data-asset-id={assetId} data-system-id={systemId} />,
}))

const json = (payload: unknown) => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })

describe('PatchPage SSH integration', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    window.history.replaceState({}, '', '/patch/ssh')
    localStorage.setItem('itms_token', 'test-token')
    fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/departments') return Promise.resolve(json([]))
      if (String(input) === '/api/patch/dashboard') return Promise.resolve(json({ total: 2, upToDate: 0, pending: 2, failed: 0, rebootPending: 0 }))
      if (String(input) === '/api/patch/devices') return Promise.resolve(json([
        { id: 'asset-1', assetTag: 'TAG-1', hostname: 'host-1', patchStatus: 'pending' },
        { id: 'asset-2', hostname: 'host-2' },
      ]))
      throw new Error(`Unexpected API request: ${String(input)}`)
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('shows unknown when an endpoint has no recorded patch status', async () => {
    render(<PatchPage />)
    await screen.findByText('Live API')
    expect(within(screen.getByRole('row', { name: /host-2/ })).getByText('Unknown')).toBeVisible()
  })

  it('filters the endpoint table without opening a session', async () => {
    render(<PatchPage />)
    await screen.findByText('Live API')
    fireEvent.change(screen.getByLabelText('Search SSH endpoints'), { target: { value: 'host-2' } })
    expect(screen.queryByText('host-1')).not.toBeInTheDocument()
    expect(screen.getByText('host-2')).toBeVisible()
    expect(screen.getAllByRole('button', { name: 'SSH Terminal' })).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('Search SSH endpoints'), { target: { value: 'missing-host' } })
    expect(screen.getByText('No matching endpoints.')).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.map(([path]) => path).sort()).toEqual(['/api/departments', '/api/patch/dashboard', '/api/patch/devices'])
  })

  it('owns no duplicate session request, closes the terminal, and opens a different managed asset', async () => {
    render(<PatchPage />)
    await screen.findByText('Live API')
    fireEvent.click(screen.getAllByRole('button', { name: 'SSH Terminal' })[0])
    expect(screen.getByRole('dialog', { name: 'SSH · TAG-1' })).toBeVisible()
    expect(screen.getByTestId('ssh-terminal')).toHaveAttribute('data-asset-id', 'asset-1')
    expect(screen.getByTestId('ssh-terminal').parentElement).toHaveClass('min-w-0', 'max-w-full', 'overflow-x-hidden', 'p-2')
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(screen.queryByTestId('ssh-terminal')).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'SSH Terminal' })[1])
    expect(screen.getByTestId('ssh-terminal')).toHaveAttribute('data-asset-id', 'asset-2')
    expect(screen.getByTestId('ssh-terminal')).toHaveAttribute('data-system-id', 'host-2')
    expect(fetchMock.mock.calls.map(([path]) => path).sort()).toEqual(['/api/departments', '/api/patch/dashboard', '/api/patch/devices'])
  })

  it('unmounts the terminal when browser navigation leaves SSH and does not reopen it on return', async () => {
    render(<PatchPage />)
    await screen.findByText('Live API')
    fireEvent.click(screen.getAllByRole('button', { name: 'SSH Terminal' })[0])
    act(() => { window.history.replaceState({}, '', '/patch'); window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(screen.queryByTestId('ssh-terminal')).not.toBeInTheDocument()
    act(() => { window.history.replaceState({}, '', '/patch/ssh'); window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('unmounts SSH immediately on authentication changes', async () => {
    render(<PatchPage />)
    await screen.findByText('Live API')
    fireEvent.click(screen.getAllByRole('button', { name: 'SSH Terminal' })[0])
    localStorage.removeItem('itms_token')
    act(() => window.dispatchEvent(new Event('itms-auth-changed')))
    expect(screen.queryByTestId('ssh-terminal')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})