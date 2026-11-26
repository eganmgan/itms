import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accessFailure, adminRequest, useAdminAccess, useAdminResource } from './api'
import { deferred, json } from './fixtures.test-support'
import { notifyRecordChange } from '../lib/recordChanges'
import { useManualWrite } from '../manual-entry/api'

describe('admin request lifecycle', () => {
  beforeEach(() => {
    localStorage.setItem('itms_token', 'account-a')
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it.each(['', 'other-account'])('does not fetch using inactive token %j', async token => {
    await expect(adminRequest(token, '/admin/assets', new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not fetch an already aborted request', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(adminRequest('account-a', '/admin/assets', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([401, 403])('does not parse HTTP %s bodies', async status => {
    const response = json({ error: 'Private response' }, status)
    const parse = vi.spyOn(response, 'json')
    vi.mocked(fetch).mockResolvedValue(response)
    const error = await adminRequest('account-a', '/admin/assets', new AbortController().signal).catch(error => error)
    expect(accessFailure(error)).toBe(true)
    if (!(error instanceof Error)) throw new Error('Expected an API error')
    expect(error.message).not.toContain('Private response')
    expect(parse).not.toHaveBeenCalled()
  })

  it('rejects an account switch during response-body parsing even without an auth event', async () => {
    const body = deferred<{ name: string }>()
    const response = json({})
    const parse = vi.spyOn(response, 'json').mockImplementation(() => body.promise)
    vi.mocked(fetch).mockResolvedValue(response)
    const request = adminRequest('account-a', '/admin/assets', new AbortController().signal)
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await waitFor(() => expect(parse).toHaveBeenCalled())
    localStorage.setItem('itms_token', 'account-b')
    body.resolve({ name: 'Old account detail' })
    await rejected
  })

  it('aborts superseded requests and ignores late results when the transport ignores abort', async () => {
    const old = deferred<Response>()
    vi.mocked(fetch).mockImplementation(url => String(url).endsWith('/first') ? old.promise : Promise.resolve(json({ name: 'Latest' })))
    const { result, rerender, unmount } = renderHook(({ path }) => useAdminResource<{ name: string }>('account-a', path), { initialProps: { path: '/first' } })
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal
    rerender({ path: '/second' })
    expect(signal?.aborted).toBe(true)
    await waitFor(() => expect(result.current.data?.name).toBe('Latest'))
    await act(async () => old.resolve(json({ name: 'Stale' })))
    expect(result.current.data?.name).toBe('Latest')
    const currentSignal = vi.mocked(fetch).mock.calls[1][1]?.signal
    unmount()
    expect(currentSignal?.aborted).toBe(true)
  })

  it('clears loaded resources when the account changes even without a keyed parent', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ name: 'Private computer' }))
    const { result } = renderHook(() => useAdminResource<{ name: string }>('account-a', '/admin/assets'))
    await waitFor(() => expect(result.current.data?.name).toBe('Private computer'))
    act(() => {
      localStorage.setItem('itms_token', 'account-b')
      window.dispatchEvent(new StorageEvent('storage', { key: 'itms_token' }))
    })
    expect(result.current.data).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('keeps pending requests alive for redundant same-account notifications', async () => {
    const pending = deferred<Response>()
    vi.mocked(fetch).mockReturnValue(pending.promise)
    const { result } = renderHook(() => useAdminResource<{ name: string }>('account-a', '/admin/assets'))
    act(() => window.dispatchEvent(new Event('itms-auth-changed')))
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(false)
    await act(async () => pending.resolve(json({ name: 'Current computer' })))
    expect(result.current.data?.name).toBe('Current computer')
  })

  it.each(['/entities', '/locations?entity_id=company', '/departments?entity_id=company', '/admin/assets/options?entityId=company'])('refreshes shared options for %s without clearing loaded values', async path => {
    vi.mocked(fetch).mockResolvedValueOnce(json([{ id: 'existing' }]))
    const { result } = renderHook(() => useAdminResource<{ id: string }[]>('account-a', path))
    await waitFor(() => expect(result.current.data?.[0].id).toBe('existing'))
    const pending = deferred<Response>()
    vi.mocked(fetch).mockReturnValueOnce(pending.promise)
    act(() => notifyRecordChange())
    expect(result.current.data?.[0].id).toBe('existing')
    await act(async () => pending.resolve(json([{ id: 'new-branch' }])))
    expect(result.current.data?.[0].id).toBe('new-branch')
    vi.mocked(fetch).mockResolvedValueOnce(json([{ id: 'other-tab' }]))
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'itms-records-changed', newValue: 'revision' })))
    await waitFor(() => expect(result.current.data?.[0].id).toBe('other-tab'))
  })

  it.each([200, 400, 403, 500])('broadcasts master-record changes only after successful writes (%s)', async status => {
    const changed = vi.fn()
    window.addEventListener('itms-records-changed', changed)
    const onDenied = vi.fn()
    const onSaved = vi.fn()
    vi.mocked(fetch).mockResolvedValue(json({}, status))
    const { result } = renderHook(() => useManualWrite({ token: 'account-a', onDenied }))
    try {
      await act(async () => result.current.save('/locations', { full_name: 'Branch' }, onSaved))
      expect(changed).toHaveBeenCalledTimes(status === 200 ? 1 : 0)
      expect(onSaved).toHaveBeenCalledTimes(status === 200 ? 1 : 0)
      if (status === 200) expect(localStorage.getItem('itms-records-changed')).toMatch(/^\d+-\d+-\d+-\d+$/)
      else expect(localStorage.getItem('itms-records-changed')).toBeNull()
    } finally { window.removeEventListener('itms-records-changed', changed) }
  })

  it('does not reload account checks or signed-out options on record notifications', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ role: 'super_admin' }))
    const { result } = renderHook(() => useAdminAccess('account-a'))
    renderHook(() => useAdminResource('', '/locations'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => notifyRecordChange())
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('fails closed for a malformed successful identity body', async () => {
    vi.mocked(fetch).mockResolvedValue(json(null))
    const { result } = renderHook(() => useAdminAccess('account-a'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.allowed).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})