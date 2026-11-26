import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmployeeDirectory } from './EmployeeDirectory'

describe('EmployeeDirectory', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  it('shows employee details and supports portal access and password reset', async () => {
    localStorage.setItem('itms_token', 'session-token')
    localStorage.setItem('itms_user', JSON.stringify({ role: 'super_admin' }))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (!init?.method) {
        return new Response(JSON.stringify({ items: [{ id: 'user-1', emp_id: 'EMP001', full_name: 'Real Employee', email: 'employee@zerodha.com', status: 'active', entity_id: 'entity-1', dept_id: 'dept-1', location_id: 'location-1', role: 'employee', department: 'Sales', location: 'Mumbai', asset_count: 2 }], total: 1 }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })

    render(<EmployeeDirectory onNotice={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'View details' }))
    expect(screen.getByRole('heading', { name: 'Real Employee' })).toBeVisible()
    expect(screen.getByText('employee@zerodha.com')).toBeVisible()
    expect(screen.getByText('Mumbai')).toBeVisible()
    expect(screen.getByText('2')).toBeVisible()

    fireEvent.change(screen.getByRole('combobox', { name: 'Portal access' }), { target: { value: 'it_team' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save access' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({ role: 'it_team' })

    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const resetPayload = JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body)) as { initial_password: string }
    expect(resetPayload.initial_password.length).toBeGreaterThanOrEqual(8)
    expect(screen.getByLabelText('One-time password')).toHaveValue(resetPayload.initial_password)
  })
})