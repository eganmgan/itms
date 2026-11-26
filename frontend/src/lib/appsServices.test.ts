import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogInputError, mergeRecords, secureUUID, type ActionRecord } from './appsServices'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('secureUUID', () => {
  it('prefers native randomUUID and preserves existing spies', () => {
    const id = '55555555-5555-4555-8555-555555555555'
    const native = vi.spyOn(crypto, 'randomUUID').mockReturnValue(id)
    const fallback = vi.spyOn(crypto, 'getRandomValues')
    expect(secureUUID()).toBe(id)
    expect(native).toHaveBeenCalledTimes(1)
    expect(fallback).not.toHaveBeenCalled()
  })

  it.each([0, 255])('uses secure random bytes and sets RFC 4122 version/variant (%s)', byte => {
    const source = { getRandomValues: vi.fn((bytes: Uint8Array) => bytes.fill(byte)) }
    vi.stubGlobal('crypto', source)
    const insecure = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Insecure randomness forbidden') })
    expect(secureUUID()).toBe(byte ? 'ffffffff-ffff-4fff-bfff-ffffffffffff' : '00000000-0000-4000-8000-000000000000')
    expect(source.getRandomValues).toHaveBeenCalledExactlyOnceWith(expect.any(Uint8Array))
    expect(source.getRandomValues.mock.calls[0][0]).toHaveLength(16)
    expect(insecure).not.toHaveBeenCalled()
  })

  it.each([undefined, {}])('fails closed without a cryptographic source (%s)', source => {
    vi.stubGlobal('crypto', source)
    expect(() => secureUUID()).toThrow('Secure UUID generation is unavailable')
  })

  it('does not mask a cryptographic generator failure', () => {
    vi.stubGlobal('crypto', { getRandomValues: () => { throw new Error('CSPRNG failed') } })
    expect(() => secureUUID()).toThrow('CSPRNG failed')
  })
})

describe('catalogInputError', () => {
  it.each(['a', '0', 'Vendor.App_1+2-3', 'a'.repeat(200)])('accepts backend package identifier %s', identifier => {
    expect(catalogInputError('Approved app', identifier, '')).toBe('')
  })
  it.each(['', '-flag', 'with space', 'name;cmd', 'path/pkg', 'pkg:arch', 'pkg\n', 'é', 'a'.repeat(201)])('rejects backend-invalid identifier %s', identifier => {
    expect(catalogInputError('Approved app', identifier, '')).toMatch(/Package identifier/)
  })
  it('bounds names and descriptions and rejects null characters', () => {
    expect(catalogInputError('a'.repeat(150), 'pkg', 'd'.repeat(4000))).toBe('')
    for (const name of ['', '  ', 'a'.repeat(151), 'a\0']) expect(catalogInputError(name, 'pkg', '')).toMatch(/Application name/)
    for (const description of ['d'.repeat(4001), 'd\0']) expect(catalogInputError('App', 'pkg', description)).toMatch(/Description/)
  })
})

describe('outcome recovery', () => {
  const record: ActionRecord = { requestId: '55555555-5555-4555-8555-555555555555', assetId: 'asset', kind: 'software', action: 'install', applicationId: 'application', status: 'unknown', outcomeCode: 'dispatch_unconfirmed', createdAt: '2099-01-01', updatedAt: '2099-01-01' }
  it('keeps install and management UUID namespaces separate', () => {
    expect(mergeRecords([record], [{ ...record, action: 'remove' }])).toHaveLength(2)
  })
  it('never lets an unknown snapshot override a verified terminal outcome, regardless of browser clock', () => {
    const final = { ...record, status: 'succeeded' as const, updatedAt: '2026-09-21' }
    expect(mergeRecords([record], [final])).toEqual([final])
    expect(mergeRecords([final], [record])).toEqual([final])
  })
})