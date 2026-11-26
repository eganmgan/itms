interface TrendBucket {
  date?: unknown
  count?: unknown
}

export function normalizeTrendBuckets(value: unknown): Array<{ date: string; count: number }> {
  if (!Array.isArray(value)) return []
  return value.map((item, index) => {
    const bucket = item && typeof item === 'object' ? item as TrendBucket : {}
    const date = typeof bucket.date === 'string' && bucket.date.trim() ? bucket.date : `Day ${index + 1}`
    const count = typeof bucket.count === 'number' && Number.isFinite(bucket.count) ? bucket.count : 0
    return { date, count }
  })
}