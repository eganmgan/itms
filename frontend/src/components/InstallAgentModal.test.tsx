import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InstallAgentModal } from './InstallAgentModal'

describe('InstallAgentModal', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('generates the full Linux command for the selected employee', async () => {
    localStorage.setItem('itms_token', 'session-token')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ command: 'secure-command', os: 'linux', user: { fullName: 'IT User', email: 'it@example.com', employeeCode: 'EMP-1' } }), { status: 200 }))

    render(<InstallAgentModal departments={[{ id: 'it', name: 'IT Team', deviceCount: 1 }]} users={[{ id: 'user-1', fullName: 'IT User', email: 'it@example.com', employeeCode: 'EMP-1', departmentId: 'it', departmentName: 'IT Team', branchName: 'HQ', assetCount: 0, newAssetCount: 0, ungroupedAssetCount: 0, flaggedAssetCount: 0, status: 'unassigned' }]} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /^Ubuntu \/ Debian/i }))
    fireEvent.click(screen.getByRole('combobox', { name: /Department/i }))
    fireEvent.pointerDown(screen.getByRole('option', { name: 'IT Team' }))
    fireEvent.click(screen.getByRole('button', { name: /^Generate command$/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const request = fetchMock.mock.calls[1][1] as RequestInit
    expect(JSON.parse(String(request.body))).toEqual({ userId: 'user-1', os: 'linux' })
    expect(await screen.findByText('secure-command')).toBeVisible()
    expect(screen.getByText('Passwordless SSH key')).toBeVisible()
  })

  it('copies the command with a fallback when clipboard access is denied', async () => {
    localStorage.setItem('itms_token', 'session-token')
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ command: 'secure-command', os: 'linux', user: { fullName: 'IT User', email: 'it@example.com', employeeCode: 'EMP-1' } }), { status: 200 }))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })

    render(<InstallAgentModal departments={[{ id: 'it', name: 'IT Team', deviceCount: 1 }]} users={[{ id: 'user-1', fullName: 'IT User', email: 'it@example.com', employeeCode: 'EMP-1', departmentId: 'it', departmentName: 'IT Team', branchName: 'HQ', assetCount: 0, newAssetCount: 0, ungroupedAssetCount: 0, flaggedAssetCount: 0, status: 'unassigned' }]} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('combobox', { name: /Department/i }))
    fireEvent.pointerDown(screen.getByRole('option', { name: 'IT Team' }))
    fireEvent.click(screen.getByRole('button', { name: /^Generate command$/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Copy command/i }))

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'))
    expect(screen.getByRole('button', { name: /Copied/i })).toBeVisible()
  })

  it.each([
    ['Windows', 'windows'],
    ['Fedora / RHEL', 'fedora'],
    ['macOS', 'macos'],
  ])('requests an installer for %s', async (buttonName, os) => {
    localStorage.setItem('itms_token', 'session-token')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ command: 'secure-command', os, user: { fullName: 'IT User', email: 'it@example.com', employeeCode: 'EMP-1', departmentName: 'IT Team' } }), { status: 200 }))

    render(<InstallAgentModal departments={[{ id: 'it', name: 'IT Team', deviceCount: 1 }]} users={[{ id: 'user-1', fullName: 'IT User', email: 'it@example.com', employeeCode: 'EMP-1', departmentId: 'it', departmentName: 'IT Team', branchName: 'HQ', assetCount: 0, newAssetCount: 0, ungroupedAssetCount: 0, flaggedAssetCount: 0, status: 'unassigned' }]} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${buttonName}`, 'i') }))
    fireEvent.click(screen.getByRole('combobox', { name: /Department/i }))
    fireEvent.pointerDown(screen.getByRole('option', { name: 'IT Team' }))
    fireEvent.click(screen.getByRole('button', { name: /^Generate command$/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const request = fetchMock.mock.calls[1][1] as RequestInit
    expect(JSON.parse(String(request.body))).toEqual({ userId: 'user-1', os })
  })

  it('loads fallback employees when the directory only provides a department name', () => {
    render(<InstallAgentModal departments={[{ id: 'it', name: 'IT Team', deviceCount: 1 }]} users={[{ id: 'user-1', fullName: 'IT User', email: 'it@example.com', employeeCode: 'EMP-1', departmentName: 'IT Team', branchName: 'HQ', assetCount: 0, newAssetCount: 0, ungroupedAssetCount: 0, flaggedAssetCount: 0, status: 'unassigned' }]} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('combobox', { name: /Department/i }))
    fireEvent.pointerDown(screen.getByRole('option', { name: 'IT Team' }))
    expect(screen.getByRole('combobox', { name: /Department/i })).toHaveTextContent('IT Team')
    expect(screen.getByRole('combobox', { name: /Employee name/i })).toHaveTextContent('IT User · EMP-1')
  })

  it('fetches active employees when the department changes', async () => {
    localStorage.setItem('itms_token', 'session-token')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [{ id: 'user-2', full_name: 'Engineering User', email: 'eng@example.com', emp_id: 'EMP-2', dept_id: 'eng', department: 'Engineering' }] }), { status: 200 }))

    render(<InstallAgentModal departments={[{ id: 'it', name: 'IT Team', deviceCount: 1 }, { id: 'eng', name: 'Engineering', deviceCount: 1 }]} users={[{ id: 'user-1', fullName: 'IT User', email: 'it@example.com', employeeCode: 'EMP-1', departmentId: 'it', departmentName: 'IT Team', branchName: 'HQ', assetCount: 0, newAssetCount: 0, ungroupedAssetCount: 0, flaggedAssetCount: 0, status: 'unassigned' }]} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('combobox', { name: /Department/i }))
    fireEvent.click(screen.getByRole('option', { name: 'Engineering' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/users?dept=eng&status=active&paginate=1&page_size=200', { headers: { Authorization: 'Bearer session-token' } }))
    expect(await screen.findByRole('combobox', { name: /Employee name/i })).toHaveTextContent('Engineering User · EMP-2')
  })

  it('keeps the department options open during pointer interaction', () => {
    render(<InstallAgentModal departments={[{ id: 'it', name: 'IT Team', deviceCount: 1 }, { id: 'eng', name: 'Engineering', deviceCount: 1 }]} users={[{ id: 'user-1', fullName: 'IT User', email: 'it@example.com', employeeCode: 'EMP-1', departmentId: 'it', departmentName: 'IT Team', branchName: 'HQ', assetCount: 0, newAssetCount: 0, ungroupedAssetCount: 0, flaggedAssetCount: 0, status: 'unassigned' }]} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('combobox', { name: /Department/i }))
    fireEvent.mouseDown(screen.getByRole('listbox', { name: /Department options/i }))

    expect(screen.getByRole('listbox', { name: /Department options/i })).toBeVisible()
  })

  it('selects a department on pointer down', () => {
    render(<InstallAgentModal departments={[{ id: 'it', name: 'IT Team', deviceCount: 1 }, { id: 'eng', name: 'Engineering', deviceCount: 1 }]} users={[{ id: 'user-1', fullName: 'IT User', email: 'it@example.com', employeeCode: 'EMP-1', departmentId: 'it', departmentName: 'IT Team', branchName: 'HQ', assetCount: 0, newAssetCount: 0, ungroupedAssetCount: 0, flaggedAssetCount: 0, status: 'unassigned' }, { id: 'user-2', fullName: 'Engineering User', email: 'eng@example.com', employeeCode: 'EMP-2', departmentId: 'eng', departmentName: 'Engineering', branchName: 'HQ', assetCount: 0, newAssetCount: 0, ungroupedAssetCount: 0, flaggedAssetCount: 0, status: 'unassigned' }]} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('combobox', { name: /Department/i }))
    fireEvent.pointerDown(screen.getByRole('option', { name: 'Engineering' }))

    expect(screen.getByRole('combobox', { name: /Department/i })).toHaveTextContent('Engineering')
    expect(screen.queryByRole('listbox', { name: /Department options/i })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /Employee name/i })).toHaveTextContent('Engineering User · EMP-2')
  })
})