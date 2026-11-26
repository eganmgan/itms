export function warrantyNotice(expiresAt: string | null | undefined, today = new Date()): string | null {
  if (!expiresAt || !/^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) return null;
  const expiry = new Date(`${expiresAt}T00:00:00Z`);
  if (!Number.isFinite(expiry.getTime()) || expiry.toISOString().slice(0, 10) !== expiresAt) return null;
  const days = Math.round((expiry.getTime() - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86400000);
  return days < 0 ? `Warranty expired on ${expiresAt}` : days === 0 ? "Warranty expires today" : days <= 30 ? `Warranty expires in ${days} ${days === 1 ? "day" : "days"} (${expiresAt})` : null;
}