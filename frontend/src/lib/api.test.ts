import { describe, expect, it } from 'vitest'
import { readJson } from './api'

describe('readJson', () => {
  it('returns JSON payloads', async () => {
    const response = new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })

    await expect(readJson<{ status: string }>(response)).resolves.toEqual({ status: 'ok' })
  })

  it('reports an HTML rate-limit response without parsing it as JSON', async () => {
    const response = new Response('<html><head><title>429 Too Many Requests</title></head></html>', {
      status: 429,
      headers: { 'Content-Type': 'text/html' },
    })

    await expect(readJson(response)).rejects.toThrow('Too many requests. Please wait a moment and try again.')
  })
})