import type { CollectionSection } from '../../lib/appsServices'

export type RecordedValue = string | number | null | undefined
type Named = { name?: string | null } | null
type Person = { fullName?: string | null; email?: string | null; employeeCode?: string | null } | null

export interface DeviceDetail {
  canEditLifecycle?: boolean
  name?: string | null
  hostname?: string | null
  assetId?: string | null
  deviceType?: string | null
  manufacturer?: string | null
  osName?: string | null
  osVersion?: RecordedValue
  osBuild?: RecordedValue
  kernelVersion?: RecordedValue
  biosVersion?: RecordedValue
  processor?: string | null
  memory?: RecordedValue
  storage?: RecordedValue
  architecture?: string | null
  model?: string | null
  serialNumber?: string | null
  lastSeenAt?: string | null
  collectionStatus?: Record<string, CollectionSection>
  services?: Array<{ name: string; display_name?: string; state?: string; start_mode?: string; source?: string }>
  servicesLastSuccessAt?: string | null
  pendingUpdates?: number | null
  pendingUpdateDetails?: string[] | null
  updateScanStatus?: string | null
  updateScannedAt?: string | null
  rebootRequired?: boolean | null
  anydeskId?: RecordedValue
  rustdeskId?: RecordedValue
  macAddress?: RecordedValue
  // Collector JSON is not a fixed schema. Never render arbitrary objects or keys.
  network?: unknown
  patchStatus?: string | null
  complianceScore?: number | null
  status?: string | null
  purchaseDate?: string | null
  addedOn?: string | null
  scrappedOn?: string | null
  cost?: RecordedValue
  warrantyStartDate?: string | null
  warrantyDurationMonths?: RecordedValue
  warrantyExpiresAt?: string | null
  updateSources?: string | null
  user?: Person
  technicianInCharge?: Person
  branch?: Named
  department?: Named
  groupInCharge?: Named
  supplier?: Named
  installedApps?: Array<{ id?: string; name?: string | null; version?: RecordedValue; source?: string | null }> | null
}

export interface DeviceHistory { id?: string; actor?: string | null; action?: string | null; created_at?: string | null }
export interface DeviceAlert { id?: string; title?: string | null; detail?: string | null; severity?: string | null; source?: string | null; resolved?: boolean | null }
export interface Connectivity {
  connected: boolean | null
  connectivitySource: 'agent_heartbeat' | 'salt_ping' | 'salt_unavailable' | 'salt_unconfigured' | 'unmanaged'
  connectivityCheckedAt: string | null
  lastHeartbeatAt?: string | null
}

export function recorded(value: RecordedValue): string {
  return scalar(value) == null ? 'Not recorded' : String(value)
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function scalar(value: unknown): string | number | undefined {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

function first(data: Record<string, unknown>, ...keys: string[]): RecordedValue {
  for (const key of keys) {
    const value = scalar(data[key])
    if (value !== undefined) return value
  }
}

function addresses(value: unknown): RecordedValue {
  if (!Array.isArray(value)) return scalar(value)
  const values = value.map(item => scalar(item) ?? first(object(item), 'local', 'address')).filter(item => item != null)
  return values.length ? values.join(', ') : undefined
}

export type InventorySection = { title: string; fields: Array<[string, RecordedValue]> }

export function networkSection(detail: DeviceDetail): InventorySection {
  const network = object(detail.network)
  return { title: 'Network', fields: [
    ['Last inventory report', detail.lastSeenAt], ['Wired IP', first(network, 'wired_ip', 'wiredIp')],
    ['Wireless IP', first(network, 'wireless_ip', 'wirelessIp')], ['NetBird IP', first(network, 'netbird_ip', 'netbirdIp')],
    ['MAC address', detail.macAddress], ['Gateway', first(network, 'gateway')], ['DNS servers', addresses(network.dns)],
  ] }
}

// Python/Linux/macOS collectors send a name-keyed map; older/imported snapshots
// can contain arrays or ip -j records. Only known telemetry fields are displayed:
// no raw JSON dump, credentials, arbitrary metadata, or inferred interface types.
export function networkInterfaces(detail: DeviceDetail): InventorySection[] {
  const network = object(detail.network)
  const stats = network.interface_stats ?? network.interfaceStats
  const entries: Array<[string | undefined, unknown]> = Array.isArray(stats)
    ? stats.map(value => [undefined, value])
    : Object.entries(object(stats))
  return entries.flatMap(([key, raw]) => {
    const data = object(raw)
    const counters = object(data.stats64 ?? data.stats)
    const rx = object(counters.rx), tx = object(counters.tx)
    const fields: InventorySection['fields'] = [
      ['Interface', first(data, 'name', 'ifname', 'interface') ?? key],
      ['IP addresses', addresses(data.addresses ?? data.addr_info ?? data.ip_addresses)],
      ['MAC address', first(data, 'mac', 'mac_address', 'macAddress', 'address')],
      ['Reported state', first(data, 'state', 'operstate', 'status')],
      ['MTU', first(data, 'mtu')], ['Hardware port', first(data, 'hardware_port', 'hardwarePort')],
      ['Gateway', first(data, 'gateway')], ['DNS servers', addresses(data.dns)],
      ['Link speed (Mbps)', first(data, 'speed_mbps')],
      ['Received bytes', first(data, 'rx_bytes') ?? first(rx, 'bytes')],
      ['Transmitted bytes', first(data, 'tx_bytes') ?? first(tx, 'bytes')],
      ['Received packets', first(data, 'rx_packets') ?? first(rx, 'packets')],
      ['Transmitted packets', first(data, 'tx_packets') ?? first(tx, 'packets')],
      ['Receive errors', first(data, 'rx_errors') ?? first(rx, 'errors')],
      ['Transmit errors', first(data, 'tx_errors') ?? first(tx, 'errors')],
      ['Receive drops', first(data, 'rx_dropped') ?? first(rx, 'dropped')],
      ['Transmit drops', first(data, 'tx_dropped') ?? first(tx, 'dropped')],
    ]
    // A map key alone is not evidence of an interface; skip malformed/unknown
    // records instead of leaking metadata keys as interface names.
    if (!fields.slice(1).some(([, value]) => scalar(value) !== undefined)) return []
    return [{ title: `Interface ${recorded(fields[0][1])}`, fields }]
  })
}

// Do not coerce strings or infer reachability from inventory age / asset status.
export function parseConnectivity(value: unknown): Connectivity {
  if (!value || typeof value !== 'object') throw new Error('Invalid connectivity response')
  const data = value as Record<string, unknown>
  const sources = ['agent_heartbeat', 'salt_ping', 'salt_unavailable', 'salt_unconfigured', 'unmanaged']
  if (!sources.includes(String(data.connectivitySource)) ||
      (data.connected !== null && typeof data.connected !== 'boolean') ||
      (data.connectivityCheckedAt !== null && typeof data.connectivityCheckedAt !== 'string')) {
    throw new Error('Invalid connectivity response')
  }
  const heartbeat = data.connectivitySource === 'agent_heartbeat'
  if (heartbeat && (data.lastHeartbeatAt !== null && (typeof data.lastHeartbeatAt !== 'string' || !Number.isFinite(Date.parse(data.lastHeartbeatAt))))) {
    throw new Error('Invalid connectivity response')
  }
  return {
    connected: data.connectivitySource === 'salt_ping' || heartbeat ? data.connected as boolean | null : null,
    connectivitySource: data.connectivitySource as Connectivity['connectivitySource'],
    connectivityCheckedAt: data.connectivityCheckedAt as string | null,
    ...(heartbeat ? { lastHeartbeatAt: data.lastHeartbeatAt as string | null } : {}),
  }
}

export function systemSections(detail: DeviceDetail) {
  const duration = recorded(detail.warrantyDurationMonths)
  return [
    { title: 'Computer Details', fields: [
      ['Name', detail.name?.trim() ? detail.name : detail.hostname], ['Location', detail.branch?.name],
      ['Technician in Charge', detail.technicianInCharge?.fullName], ['Group in Charge', detail.groupInCharge?.name],
      ['Department', detail.department?.name], ['User', detail.user?.fullName], ['Email', detail.user?.email],
      ['Employee Code', detail.user?.employeeCode], ['Asset Status', detail.status], ['Computer Type', detail.deviceType],
      ['Manufacturer', detail.manufacturer], ['Serial Number', detail.serialNumber], ['Inventory/Asset Number', detail.assetId],
      ['Update Sources', detail.updateSources],
    ] },
    { title: 'Operating System', fields: [
      ['Name', detail.osName], ['Version', detail.osVersion], ['Build', detail.osBuild],
      ['Kernel Version', detail.kernelVersion], ['Architecture', detail.architecture], ['BIOS Version', detail.biosVersion],
    ] },
    { title: 'Management - Asset Lifecycle', fields: [['Date of Purchase', detail.purchaseDate]] },
    { title: 'Financial & Administrative Information', fields: [
      ['Supplier', detail.supplier?.name], [`Value (${import.meta.env.VITE_CURRENCY_CODE || 'INR'})`, detail.cost],
    ] },
    { title: 'Warranty Information', fields: [
      ['Warranty Start Date', detail.warrantyStartDate],
      ['Warranty Duration', duration === 'Not recorded' ? undefined : `${duration} months`],
      ['Warranty Expiry Date', detail.warrantyExpiresAt],
    ] },
    { title: 'Hardware Inventory', fields: [
      ['Hostname', detail.hostname], ['Model', detail.model], ['Processor', detail.processor],
      ['Memory', detail.memory], ['Storage', detail.storage],
    ] },
  ] satisfies Array<{ title: string; fields: Array<[string, RecordedValue]> }>
}