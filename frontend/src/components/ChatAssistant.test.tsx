import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatAssistant } from './ChatAssistant'

describe('ChatAssistant', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('opens one chat workspace with tabs for the two chat services', () => {
    render(<ChatAssistant context="Devices" />)

    fireEvent.click(screen.getByRole('button', { name: /open itms assistant/i }))

    expect(screen.getByRole('heading', { name: 'Chat' })).toBeVisible()
    expect(screen.getByText('Sign in to view and send messages.')).toBeVisible()
    expect(screen.getByRole('tabpanel', { name: 'ITMS Support' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'ITMS Support' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Mattermost' })).toHaveAttribute('aria-selected', 'false')
    fireEvent.click(screen.getByRole('tab', { name: 'Mattermost' }))
    expect(screen.getByRole('tabpanel', { name: 'Mattermost' })).toBeVisible()
    expect(screen.getByText('Sign in to view Mattermost.')).toBeVisible()
    expect(screen.queryByText(/guidance/i)).not.toBeInTheDocument()
  })

  it('does not show a recent-chats collapse control', () => {
    render(<ChatAssistant context="Devices" />)
    fireEvent.click(screen.getByRole('button', { name: /open itms assistant/i }))

    expect(screen.queryByRole('button', { name: 'Hide recent chats' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show recent chats' })).not.toBeInTheDocument()
    expect(screen.getByText('Sign in to see your chats.')).toBeVisible()
    expect(screen.getByRole('region', { name: 'ITMS assistant' })).toBeVisible()
  })

  it('opens a compact chat pod and closes it with Escape', () => {
    render(<ChatAssistant context="Devices" />)
    fireEvent.click(screen.getByRole('button', { name: /open itms assistant/i }))
    const workspace = screen.getByRole('region', { name: 'ITMS assistant' })
    expect(workspace).toHaveClass('relative', 'h-[min(640px,calc(100dvh-5rem))]')
    expect(screen.getByRole('separator', { name: 'Resize chat width' })).toHaveAttribute('aria-valuenow', '720')
    expect(screen.getByRole('button', { name: 'Close assistant' })).toBeVisible()
    expect(screen.getByText('Sign in to see your chats.')).toBeVisible()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: 'ITMS assistant' })).not.toBeInTheDocument()
  })

  it('resizes the recent-chats tray with the keyboard', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(718)
    render(<ChatAssistant context="Devices" />)
    fireEvent.click(screen.getByRole('button', { name: /open itms assistant/i }))
    const handle = screen.getByRole('separator', { name: 'Resize recent chats width' })
    expect(handle).toHaveAttribute('aria-valuenow', '180')
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(handle).toHaveAttribute('aria-valuenow', '160')
    fireEvent.keyDown(handle, { key: 'End' })
    expect(handle).toHaveAttribute('aria-valuenow', '380')
  })

  it('opens full-page sign in from the chat workspace', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const signIn = vi.fn()
    window.addEventListener('itms-open-sign-in', signIn)
    render(<ChatAssistant context="Devices" />)

    fireEvent.click(screen.getByRole('button', { name: /open itms assistant/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(signIn).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
    window.removeEventListener('itms-open-sign-in', signIn)
  })

  it('switches to the configured Mattermost embed in the same chat workspace', async () => {
    localStorage.setItem('itms_token', 'fixture-token')
    vi.stubGlobal('fetch', vi.fn(async url => {
      if (String(url).endsWith('/integrations/mattermost/embed-config')) {
        return new Response(JSON.stringify({ configured: true, baseUrl: 'http://localhost:8065' }), { status: 200 })
      }
      return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 })
    }))
    render(<ChatAssistant context="Devices" />)

    fireEvent.click(screen.getByRole('button', { name: /open itms assistant/i }))
    const supportPane = screen.getByRole('tabpanel', { name: 'ITMS Support' })
    expect(supportPane).toBeVisible()
    expect(screen.getByRole('tab', { name: 'ITMS Support' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Mattermost' })).toHaveAttribute('aria-selected', 'false')

    fireEvent.click(screen.getByRole('tab', { name: 'Mattermost' }))
    expect(await screen.findByTitle('Mattermost workspace')).toHaveAttribute('src', 'http://localhost:8065')
    expect(screen.queryByRole('link', { name: 'Open Mattermost' })).not.toBeInTheDocument()
    expect(screen.getByRole('tabpanel', { name: 'Mattermost' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Mattermost' })).toHaveAttribute('aria-selected', 'true')
    expect(supportPane).not.toBeVisible()
  })
})
