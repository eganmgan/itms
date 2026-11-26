export type CatalogRecord = { id: string; name: string; [key: string]: string | null }
export type CatalogField = { key: string; label: string; required?: boolean; max: number; multiline?: boolean; choices?: readonly string[] }
export type CatalogConfig = { path: string; title: string; singular: string; notice: string; scoped?: boolean; fields: CatalogField[] }
export type CatalogProps = { token: string; onDenied: () => void }

export function catalogPayload(config: CatalogConfig, draft: Record<string, string>, original?: CatalogRecord) {
  const payload: Record<string, string | null> = {}
  for (const field of config.fields) {
    const raw = draft[field.key] ?? ''
    if (original && raw === (original[field.key] ?? '')) continue
    const value = field.key === 'body' ? raw : raw.trim()
    if (field.required && !value.trim()) throw new Error(`${field.label} is required.`)
    if (value.includes('\0') || [...value].length > field.max) throw new Error(`${field.label} is too long or contains invalid characters.`)
    if (field.choices && !field.choices.includes(value)) throw new Error(`Select a valid ${field.label.toLowerCase()}.`)
    if (field.key === 'entityId' && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) throw new Error('Select a valid entity.')
    payload[field.key] = value || null
  }
  if (!Object.keys(payload).length) throw new Error('No changes to save.')
  return payload
}