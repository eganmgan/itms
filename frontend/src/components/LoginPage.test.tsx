import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginPage } from './LoginPage'

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const credentials = () => {
  fireEvent.change(screen.getByLabelText(/employee id or zerodha email/i), { target: { value: ' Z1042 ' } })
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'FixturePassword!' } })
  fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }))
}

describe('LoginPage', () => {
  beforeEach(() => { localStorage.clear(); vi.stubGlobal('fetch', vi.fn()) })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('uses truthful session guidance, disabled Google, and administrator reset help without requests', () => {
    render(<LoginPage onAuthenticated={vi.fn()} />)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByText(/server may expire your session sooner/i)).toBeVisible()
    expect(screen.getByText(/10 minutes of inactivity/i)).toBeVisible()
    expect(screen.getByRole('button', { name: /Google/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Google/ }))
    fireEvent.click(screen.getByRole('button', { name: /forgot password/i }))
    expect(screen.getByText(/Contact your ITMS administrator/)).toBeVisible()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('validates missing and whitespace identity and password without requests', async () => {
    render(<LoginPage onAuthenticated={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Sign in$/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Enter your employee ID/)
    fireEvent.change(screen.getByLabelText(/employee id/i), { target: { value: '   ' } })
    fireEvent.change(screen.getByLabelText(/^Password$/), { target: { value: 'fixture' } })
    fireEvent.click(screen.getByRole('button', { name: /^Sign in$/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Sign in$/ })).toBeEnabled())
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['401', () => json({ error: 'Invalid credentials' }, 401), /Invalid credentials/],
    ['non-JSON', () => new Response('<html>bad gateway</html>', { status: 502 }), /temporarily unavailable/],
    ['malformed JSON', () => new Response('{', { headers: { 'Content-Type': 'application/json' } }), /./],
    ['missing token', () => json({}), /token was not returned/],
    ['empty token', () => json({ token: '' }), /token was not returned/],
    ['whitespace token', () => json({ token: '   ' }), /token was not returned/],
    ['non-string token', () => json({ token: 42 }), /token was not returned/],
    ['null response', () => json(null), /token was not returned/],
    ['MFA without email', () => json({ mfaRequired: true }), /MFA email was not returned/],
  ])('does not complete authentication for %s', async (_name, response, error) => {
    vi.mocked(fetch).mockResolvedValue(response())
    const complete = vi.fn()
    render(<LoginPage onAuthenticated={complete} />)
    credentials()
    expect(await screen.findByRole('alert')).toHaveTextContent(error)
    expect(localStorage.getItem('itms_token')).toBeNull()
    expect(complete).not.toHaveBeenCalled()
    expect(screen.getByLabelText(/^Password$/)).toHaveValue('')
  })

  it('stores only a successful token and emits auth changed before completion', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ token: 'fixture-token' }))
    const changed = vi.fn()
    window.addEventListener('itms-auth-changed', changed)
    const complete = vi.fn(() => expect(localStorage.getItem('itms_token')).toBe('fixture-token'))
    render(<LoginPage onAuthenticated={complete} />)
    credentials()
    await waitFor(() => expect(complete).toHaveBeenCalledOnce())
    expect(changed).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST', body: JSON.stringify({ identity: 'Z1042', password: 'FixturePassword!' }) }))
    expect(Object.keys(localStorage).sort()).toEqual(['itms-last-activity', 'itms-login-identity', 'itms_token'])
    expect(localStorage.getItem('itms-login-identity')).toBe(' Z1042 ')
    expect(Number(localStorage.getItem('itms-last-activity'))).toBeGreaterThan(0)
    window.removeEventListener('itms-auth-changed', changed)
  })

  it('requires MFA verification and a token, allows retries, and sends only email/code', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ mfaRequired: true, email: 'fixture@example.test', token: 'not-final' }))
      .mockResolvedValueOnce(json({ error: 'Invalid MFA code' }, 401))
      .mockResolvedValueOnce(json({ token: ' ' }))
      .mockResolvedValueOnce(json({ mfaRequired: true, email: 'fixture@example.test' }))
      .mockResolvedValueOnce(json({ token: 'verified-fixture' }))
    const complete = vi.fn()
    render(<LoginPage onAuthenticated={complete} />)
    credentials()
    expect(await screen.findByLabelText('MFA code')).toHaveFocus()
    expect(screen.queryByLabelText(/^Password$/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Verify MFA' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter your MFA code.')
    expect(fetch).toHaveBeenCalledTimes(1)
    for (const error of [/Invalid MFA code/, /token was not returned/, null]) {
      fireEvent.change(screen.getByLabelText('MFA code'), { target: { value: ' 123456 ' } })
      fireEvent.click(screen.getByRole('button', { name: 'Verify MFA' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Verify MFA' })).toBeEnabled())
      if (error) expect(screen.getByRole('alert')).toHaveTextContent(error)
      expect(localStorage.getItem('itms_token')).toBeNull()
      expect(complete).not.toHaveBeenCalled()
    }
    fireEvent.change(screen.getByLabelText('MFA code'), { target: { value: ' backup-code ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify MFA' }))
    await waitFor(() => expect(complete).toHaveBeenCalledOnce())
    expect(localStorage.getItem('itms_token')).toBe('verified-fixture')
    expect(fetch).toHaveBeenLastCalledWith('/api/auth/login/verify-mfa', expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: 'fixture@example.test', code: 'backup-code' }) }))
  })

  it('can leave MFA and re-enter credentials without persisting passwords', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ mfaRequired: true, email: 'fixture@example.test' }))
    render(<LoginPage onAuthenticated={vi.fn()} />)
    credentials()
    await screen.findByLabelText('MFA code')
    fireEvent.click(screen.getByRole('button', { name: 'Use a different account' }))
    expect(screen.getByLabelText(/^Password$/)).toHaveValue('')
    expect(localStorage.length).toBe(0)
  })

  it.each(['unmount', 'account change'])('ignores a late successful login after %s', async (reason) => {
    let resolve!: (response: Response) => void
    vi.mocked(fetch).mockReturnValue(new Promise<Response>(done => { resolve = done }))
    const complete = vi.fn()
    const { unmount } = render(<LoginPage onAuthenticated={complete} />)
    credentials()
    expect(screen.getByRole('button', { name: 'Signing in...' })).toBeDisabled()
    if (reason === 'unmount') unmount()
    else act(() => window.dispatchEvent(new Event('itms-auth-changed')))
    await act(async () => resolve(json({ token: 'late-token' })))
    expect(localStorage.getItem('itms_token')).toBeNull()
    expect(complete).not.toHaveBeenCalled()
  })

  it('reports network errors and permits retry', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network unavailable'))
    render(<LoginPage onAuthenticated={vi.fn()} />)
    credentials()
    expect(await screen.findByRole('alert')).toHaveTextContent('Network unavailable')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })
})