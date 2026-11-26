import { describe, expect, it } from 'vitest'
import { isLocalPreviewOrigin } from './vite.config'

describe('local preview proxy origin', () => {
  it.each(['localhost:5174', '127.0.0.1:5174', '[::1]:5174'])('accepts a same-origin loopback request for %s', host => {
    expect(isLocalPreviewOrigin(`http://${host}`, host)).toBe(true)
  })

  it.each([
    ['https://foreign.example', 'localhost:5174'],
    ['http://localhost:5173', 'localhost:5174'],
    ['http://127.0.0.1:5174', 'localhost:5174'],
    ['http://foreign.example:5174', 'foreign.example:5174'],
    ['null', 'localhost:5174'],
    ['http://localhost:5174/path', 'localhost:5174'],
    [undefined, 'localhost:5174'],
    ['http://localhost:5174', undefined],
  ])('preserves non-local or mismatched origin %s for backend validation', (origin, host) => {
    expect(isLocalPreviewOrigin(origin, host)).toBe(false)
  })
})