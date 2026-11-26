import { describe, expect, it } from 'vitest'
import { inventoryFreshness, inventoryReportFreshness } from './inventoryFreshness'

const now = Date.parse('2026-09-24T12:00:00Z')
describe('inventory freshness, separate from patch and connectivity status', () => {
  it('distinguishes complete, partial, stale, failed and uncollected scans', () => {
    expect(inventoryFreshness(undefined, now)).toBe('Not collected')
    expect(inventoryFreshness({ status: 'success', scanned_at: '2026-09-24T11:00:00Z' }, now)).toBe('Updated within 12 hours')
    expect(inventoryFreshness({ status: 'partial', scanned_at: '2026-09-24T11:00:00Z' }, now)).toBe('Recently updated - partial inventory')
    expect(inventoryFreshness({ status: 'success', truncated: true, scanned_at: '2026-09-24T11:00:00Z' }, now)).toContain('partial')
    expect(inventoryFreshness({ status: 'success', scanned_at: '2026-09-23T11:00:00Z' }, now)).toBe('Not updated - stale inventory')
    expect(inventoryFreshness({ status: 'failed', scanned_at: '2026-09-24T11:00:00Z' }, now)).toBe('Not updated - collection failed')
    expect(inventoryFreshness({ status: 'unsupported' }, now)).toBe('Unsupported')
  })
  it('does not trust missing, invalid or future timestamps', () => {
    for (const scanned_at of [undefined, 'bad', '2026-09-25T12:00:00Z']) expect(inventoryFreshness({ status: 'success', scanned_at }, now)).toContain('Unknown freshness')
    expect(inventoryReportFreshness(undefined, now)).toBe('No inventory report')
    expect(inventoryReportFreshness('2026-09-24T11:00:00Z', now)).toBe('Report recorded within 12 hours')
    expect(inventoryReportFreshness('2026-09-23T11:00:00Z', now)).toContain('Not updated')
  })
})