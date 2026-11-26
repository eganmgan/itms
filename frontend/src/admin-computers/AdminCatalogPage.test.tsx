import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminCatalogPage } from './AdminCatalogPage'
import { catalogPayload } from './catalog'
import type { CatalogConfig, CatalogRecord } from './catalog'
import { supplierConfig } from '../admin-suppliers/config'
import { scriptConfig } from '../admin-scripts/config'
import { deferred, ids, json, options } from './fixtures.test-support'

const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const writes = () => vi.mocked(fetch).mock.calls.filter(([, init]) => ['POST', 'PATCH'].includes(init?.method ?? ''))
const fixture = (config: CatalogConfig): CatalogRecord => config === scriptConfig
  ? { id: ids.asset, entityId: ids.entity, name: 'Example application', category: 'service', type: 'sh', os: 'Ubuntu', body: '#!/bin/sh\necho example\n', description: 'Review first' }
  : { id: ids.supplier, name: 'Global supplier', contactInfo: 'Business contact' }

describe.each([supplierConfig, scriptConfig])('$title records', config => {
  let record: CatalogRecord
  let canWrite: boolean
  function api(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const path = String(input)
    if (path.includes('/options')) return Promise.resolve(json(options))
    if (init?.method === 'POST' || init?.method === 'PATCH') {
      record = { ...record, ...JSON.parse(String(init.body)) }
      return Promise.resolve(json(record, init.method === 'POST' ? 201 : 200))
    }
    if (path.endsWith(`/${record.id}`)) return Promise.resolve(json(record))
    const page = new URL(path, 'http://fixture.test').searchParams.get('page')
    return Promise.resolve(json({ items: [record], page: Number(page || 1), hasMore: page !== '2', canWrite }))
  }
  async function mount() {
    const onDenied = vi.fn()
    const view = render(<AdminCatalogPage token="catalog-account" config={config} onDenied={onDenied} />)
    await screen.findByRole('button', { name: `Details for ${record.name}` })
    return { ...view, onDenied }
  }
  async function edit() {
    const view = await mount()
    fireEvent.click(screen.getByRole('button', { name: `Details for ${record.name}` }))
    fireEvent.click(await screen.findByRole('button', { name: `Edit ${config.singular}` }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save record' })).toBeEnabled())
    return view
  }
  beforeEach(() => { record = fixture(config); canWrite = true; localStorage.setItem('itms_token', 'catalog-account'); vi.stubGlobal('fetch', vi.fn(api)) })
  afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('creates, reads details, sparsely edits, and lists without execution requests', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: `Add ${config.singular}` }))
    for (const field of config.fields) change(field.label + (field.required ? ' *' : ''), record[field.key] ?? '')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save record' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }))
    fireEvent.click(await screen.findByRole('button', { name: `Edit ${config.singular}` }))
    const nameLabel = config === scriptConfig ? 'Name / application *' : 'Supplier name *'
    change(nameLabel, 'Renamed record')
    const optional = config === scriptConfig ? 'Description' : 'Contact information'
    change(optional, '')
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }))
    expect(await screen.findByRole('heading', { name: 'Renamed record' })).toBeVisible()
    expect(writes()).toHaveLength(2)
    expect(writes()[0][0]).toBe(`/api${config.path}`)
    expect(writes()[1][0]).toBe(`/api${config.path}/${record.id}`)
    expect(JSON.parse(String(writes()[1][1]?.body))).toEqual({ name: 'Renamed record', [config === scriptConfig ? 'description' : 'contactInfo']: null })
    if (config === scriptConfig) {
      expect(JSON.parse(String(writes()[0][1]?.body)).body).toBe('#!/bin/sh\necho example\n')
      expect(JSON.parse(String(writes()[0][1]?.body))).not.toHaveProperty('entityId')
      expect(screen.getByText(/Saving does not execute a script/)).toBeVisible()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }))
    expect(await screen.findByRole('button', { name: 'Details for Renamed record' })).toBeVisible()
    expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).startsWith(`/api${config.path}`) || String(url) === '/api/admin/assets/options')).toBe(true)
    expect(screen.queryByRole('button', { name: /execute|install now|run script|delete/i })).not.toBeInTheDocument()
  })

  it('uses server write capability and offers readable details without editing controls', async () => {
    canWrite = false
    await mount()
    expect(screen.queryByRole('button', { name: `Add ${config.singular}` })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: `Details for ${record.name}` }))
    await screen.findByRole('heading', { name: record.name })
    expect(screen.queryByRole('button', { name: `Edit ${config.singular}` })).not.toBeInTheDocument()
    expect(writes()).toHaveLength(0)
  })

  it('rejects invalid required fields and unchanged updates', async () => {
    await edit()
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }))
    expect(screen.getByRole('alert')).toHaveTextContent('No changes to save')
    change(config === scriptConfig ? 'Name / application *' : 'Supplier name *', ' ')
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }))
    expect(screen.getByRole('alert')).toHaveTextContent('is required')
    expect(writes()).toHaveLength(0)
  })

  it('retains dirty values on conflict without retrying a mutation', async () => {
    await edit()
    vi.mocked(fetch).mockImplementation((url, init) => init?.method === 'PATCH' ? Promise.resolve(json({ error: 'Record conflict' }, 409)) : api(url, init))
    change(config === scriptConfig ? 'Name / application *' : 'Supplier name *', 'Keep draft')
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Record conflict')
    expect(screen.getByDisplayValue('Keep draft')).toBeVisible()
    expect(writes()).toHaveLength(1)
  })

  it.each(['list', 'detail', 'write'])('aborts stale %s after account change, even when transport ignores abort', async target => {
    const view = target === 'write' ? await edit() : await mount()
    const pending = deferred<Response>()
    let signal: AbortSignal | null | undefined
    vi.mocked(fetch).mockImplementation((url, init) => {
      const hold = target === 'write' ? init?.method === 'PATCH' : target === 'detail' ? String(url).endsWith(`/${record.id}`) : String(url).includes('page=2')
      if (hold) { signal = init?.signal; return pending.promise }
      return api(url, init)
    })
    if (target === 'write') {
      change(config === scriptConfig ? 'Name / application *' : 'Supplier name *', 'Private draft')
      fireEvent.submit(screen.getByRole('form'))
      fireEvent.submit(screen.getByRole('form'))
      expect(writes()).toHaveLength(1)
    } else fireEvent.click(screen.getByRole('button', { name: target === 'list' ? 'Next' : `Details for ${record.name}` }))
    await waitFor(() => expect(signal).toBeDefined())
    act(() => { localStorage.setItem('itms_token', 'new-account'); window.dispatchEvent(new Event('itms-auth-changed')) })
    expect(signal?.aborted).toBe(true)
    await act(async () => pending.resolve(json({ ...record, name: 'Late private record' })))
    expect(screen.queryByText('Late private record')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('Private draft')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Account changed')
    expect(view.onDenied).not.toHaveBeenCalled()
  })

  it('ignores late details after returning to the list', async () => {
    await mount()
    const pending = deferred<Response>()
    vi.mocked(fetch).mockImplementation((url, init) => String(url).endsWith(`/${record.id}`) ? pending.promise : api(url, init))
    fireEvent.click(screen.getByRole('button', { name: `Details for ${record.name}` }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }))
    await act(async () => pending.resolve(json({ ...record, name: 'Stale details' })))
    expect(screen.queryByText('Stale details')).not.toBeInTheDocument()
  })

  it.skipIf(!config.scoped)('ignores stale entity-filter results and only offers permitted entities', async () => {
    await mount()
    const pending = deferred<Response>()
    let signal: AbortSignal | null | undefined
    vi.mocked(fetch).mockImplementation((url, init) => {
      if (String(url).includes(`entityId=${ids.other}`)) { signal = init?.signal; return pending.promise }
      return api(url, init)
    })
    change('Entity filter', ids.other)
    await waitFor(() => expect(signal).toBeDefined())
    expect(screen.queryByText('Example application')).not.toBeInTheDocument()
    change('Entity filter', ids.entity)
    expect(await screen.findByText('Example application')).toBeVisible()
    expect(signal?.aborted).toBe(true)
    await act(async () => pending.resolve(json({ items: [{ ...record, name: 'Other entity stale record' }], page: 1, hasMore: false, canWrite: true })))
    expect(screen.queryByText('Other entity stale record')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Entity filter')).toHaveValue(ids.entity)
  })

  it.each([401, 403])('clears records on a denied write (%s), without rendering the response body', async status => {
    const view = await edit()
    vi.mocked(fetch).mockImplementation((url, init) => init?.method === 'PATCH' ? Promise.resolve(json({ error: 'Private response body' }, status)) : api(url, init))
    change(config === scriptConfig ? 'Name / application *' : 'Supplier name *', 'Private draft')
    fireEvent.click(screen.getByRole('button', { name: 'Save record' }))
    await waitFor(() => expect(view.onDenied).toHaveBeenCalled())
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(screen.queryByText('Private response body')).not.toBeInTheDocument()
    expect(writes()).toHaveLength(1)
  })
})

describe('installation record validation', () => {
  it.each([{ type: 'powershell' }, { type: 'sls' }, { os: 'Windows' }, { body: ' ' }, { name: 'x'.repeat(151) }, { description: '\0' }])('rejects malformed draft %j', change => {
    const draft = Object.fromEntries(Object.entries({ ...fixture(scriptConfig), ...change }).map(([key, value]) => [key, value ?? '']))
    expect(() => catalogPayload(scriptConfig, draft)).toThrow()
  })
  it('does not require an entity and offers only shell scripts', () => {
    expect(scriptConfig.scoped).toBe(false)
    expect(scriptConfig.fields.some(field => field.key === 'entityId')).toBe(false)
    expect(scriptConfig.fields.find(field => field.key === 'type')?.choices).toEqual(['sh'])
  })
})