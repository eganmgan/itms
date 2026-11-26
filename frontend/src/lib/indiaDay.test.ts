import { describe, expect, it } from 'vitest'
import { indiaDay } from './indiaDay'

describe('India calendar day', () => {
  it('switches days at midnight Asia/Kolkata, not UTC midnight', () => {
    const before = Date.parse('2026-11-14T18:29:59.999Z')
    const after = Date.parse('2026-11-14T18:30:00.000Z')
    expect(indiaDay(after)).toBe(indiaDay(before) + 1)
    expect(indiaDay(Date.parse('2026-11-14T00:00:00Z'))).toBe(indiaDay(before))
  })
})
