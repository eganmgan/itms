import type { CollectionSection } from './appsServices'

export function inventoryFreshness(section?: CollectionSection | null, now = Date.now()): string {
  if (!section || section.status === 'uncollected' || !section.status) return 'Not collected'
  if (section.status === 'unsupported') return 'Unsupported'
  if (section.status === 'failed') return 'Not updated - collection failed'
  if (!['success', 'partial'].includes(section.status)) return 'Unknown collection status'
  const scanned = typeof section.scanned_at === 'string' ? Date.parse(section.scanned_at) : NaN
  const age = now - scanned
  if (!Number.isFinite(age) || age < -5 * 60 * 1000) return 'Unknown freshness - invalid or missing scan time'
  const partial = section.status === 'partial' || section.truncated === true || (section.truncated_count ?? 0) > 0 || !!section.error
  if (age > 12 * 60 * 60 * 1000) return partial ? 'Not updated - stale, partial inventory' : 'Not updated - stale inventory'
  return partial ? 'Recently updated - partial inventory' : 'Updated within 12 hours'
}

export function inventoryReportFreshness(timestamp?: string | null, now = Date.now()): string {
  if (!timestamp) return 'No inventory report'
  const age = now - Date.parse(timestamp)
  if (!Number.isFinite(age) || age < -5 * 60 * 1000) return 'Unknown report age'
  return age > 12 * 60 * 60 * 1000 ? 'Not updated - report older than 12 hours' : 'Report recorded within 12 hours'
}