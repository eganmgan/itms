import { describe, expect, it } from 'vitest'
import { networkInterfaces, networkSection, parseConnectivity, recorded, systemSections } from './model'

describe('recorded inventory values', () => {
  it.each([null, undefined, '', '   '])('maps absent %s to Not recorded', value => {
    expect(recorded(value)).toBe('Not recorded')
  })
  it.each([0, '0', '0.00', '9007199254740993.01', '1.02.003', '2026-01-31'])('preserves %s exactly', value => {
    expect(recorded(value)).toBe(String(value))
  })
  it('preserves decimal string cost and string zero warranty without group fallback', () => {
    const sections = systemSections({ cost: '0.00', warrantyDurationMonths: '0', department: { name: 'Department only' } })
    expect(sections.find(section => section.title === 'Warranty Information')?.fields).toContainEqual(['Warranty Duration', '0 months'])
    expect(sections.find(section => section.title === 'Financial & Administrative Information')?.fields).toContainEqual(['Value (INR)', '0.00'])
    expect(sections[0].fields).toContainEqual(['Group in Charge', undefined])
    expect(sections[0].fields).toContainEqual(['Department', 'Department only'])
  })
})

describe('connectivity contract', () => {
  it('preserves heartbeat status and validates its timestamp', () => {
    const data = { connected: true, connectivitySource: 'agent_heartbeat', connectivityCheckedAt: '2026-09-29T09:00:30Z', lastHeartbeatAt: '2026-09-29T09:00:00Z' }
    expect(parseConnectivity(data)).toEqual(data)
    expect(parseConnectivity({ ...data, connected: null, lastHeartbeatAt: null }).connected).toBeNull()
    expect(() => parseConnectivity({ ...data, lastHeartbeatAt: 'bad date' })).toThrow('Invalid connectivity response')
  })
  it.each([true, false, null])('preserves Salt ping connected=%s', connected => {
    const data = { connected, connectivitySource: 'salt_ping', connectivityCheckedAt: '2026-09-19T10:00:00Z' }
    expect(parseConnectivity(data)).toEqual(data)
  })
  it.each(['salt_unavailable', 'salt_unconfigured', 'unmanaged'])('never accepts online from %s', connectivitySource => {
    expect(parseConnectivity({ connected: true, connectivitySource, connectivityCheckedAt: null }).connected).toBeNull()
  })
  it.each([undefined, null, {}, { connected: 'false', connectivitySource: 'salt_ping', connectivityCheckedAt: null },
    { connected: true, connectivitySource: 'inventory_age', connectivityCheckedAt: null },
    { connected: true, connectivitySource: 'salt_ping', connectivityCheckedAt: 123 }])('rejects malformed connectivity %#', data => {
    expect(() => parseConnectivity(data)).toThrow('Invalid connectivity response')
  })
})

describe('recorded network collector shapes', () => {
  it('maps the actual snake_case snapshot and preserves zero and exact addresses', () => {
    const section = networkSection({ lastSeenAt: '2026-09-19T10:00:00Z', macAddress: '02:00:00:00:00:01', network: {
      wired_ip: '192.0.2.10/24', wireless_ip: '192.0.2.11', netbird_ip: '100.64.0.10', gateway: '192.0.2.1', dns: '192.0.2.53, 192.0.2.54',
    } })
    expect(section.fields).toEqual([
      ['Last inventory report', '2026-09-19T10:00:00Z'], ['Wired IP', '192.0.2.10/24'], ['Wireless IP', '192.0.2.11'],
      ['NetBird IP', '100.64.0.10'], ['MAC address', '02:00:00:00:00:01'], ['Gateway', '192.0.2.1'], ['DNS servers', '192.0.2.53, 192.0.2.54'],
    ])
    const interfaces = networkInterfaces({ network: { interface_stats: {
      eth0: { mtu: 0, state: 'UP', mac: '02:00:00:00:00:01', addresses: ['192.0.2.10', '2001:db8::10'], rx_bytes: 0, tx_bytes: '0', password: 'PRIVATE_METADATA' },
      en0: { state: 'UP', mac: '02:00:00:00:00:02', addresses: ['192.0.2.11'], hardware_port: 'Wi-Fi' },
      private_metadata: { token: 'PRIVATE_METADATA' }, broken: null,
    } } })
    expect(interfaces).toHaveLength(2)
    expect(interfaces[0].fields).toEqual(expect.arrayContaining([
      ['Interface', 'eth0'], ['MTU', 0], ['Received bytes', 0], ['Transmitted bytes', '0'], ['IP addresses', '192.0.2.10, 2001:db8::10'],
    ]))
    expect(interfaces[1].fields).toContainEqual(['Hardware port', 'Wi-Fi'])
    expect(JSON.stringify(interfaces)).not.toMatch(/PRIVATE_METADATA|private_metadata|password|token/)
  })

  it('accepts array and ip -j shapes without stringifying objects or dropping zero counters', () => {
    const interfaces = networkInterfaces({ network: { interface_stats: [null, 'bad', [], {
      ifname: 'eth0', address: '02:00:00:00:00:01', operstate: 'DOWN', mtu: 1500,
      addr_info: [null, { local: '192.0.2.10' }, { local: '2001:db8::10' }, { token: 'PRIVATE_METADATA' }],
      stats64: { rx: { bytes: 0, packets: 0, errors: 0, dropped: 0 }, tx: { bytes: '9007199254740993', packets: 1, errors: 0, dropped: 0 } },
    }] } })
    expect(interfaces).toHaveLength(1)
    expect(interfaces[0].fields).toEqual(expect.arrayContaining([
      ['Interface', 'eth0'], ['Reported state', 'DOWN'], ['Received bytes', 0], ['Transmitted bytes', '9007199254740993'],
      ['Receive errors', 0], ['Transmit drops', 0], ['IP addresses', '192.0.2.10, 2001:db8::10'],
    ]))
    expect(JSON.stringify(interfaces)).not.toMatch(/PRIVATE_METADATA|\[object Object\]/)
  })

  it.each([undefined, null, {}, [], '', 0, false, { interface_stats: null }, { interface_stats: [] },
    { interface_stats: { invalid: 1 } }, { interface_stats: 'bad' }])('handles absent/malformed network %#', network => {
    expect(networkInterfaces({ network })).toEqual([])
    expect(networkSection({ network }).fields.every(([, value]) => recorded(value) === 'Not recorded')).toBe(true)
  })

  it('supports camelCase compatibility fields and null/malformed array members safely', () => {
    expect(networkSection({ network: { wiredIp: '192.0.2.10', dns: [null, '192.0.2.53', {}, false] } }).fields)
      .toEqual(expect.arrayContaining([['Wired IP', '192.0.2.10'], ['DNS servers', '192.0.2.53']]))
    expect(networkInterfaces({ network: { interfaceStats: { wt0: { macAddress: '02:00:00:00:00:01', addresses: null } } } })[0].fields)
      .toContainEqual(['IP addresses', undefined])
  })
})