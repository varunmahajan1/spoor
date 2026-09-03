import { describe, expect, it } from 'vitest'
import { ipInCidr, ipInAnyCidr, isIpv4 } from '../src/cidr.js'
import { truncateIp, clientIpFromHeaders } from '../src/ip.js'

describe('CIDR matching — IPv4', () => {
  it('matches inside and rejects outside', () => {
    expect(ipInCidr('192.168.1.55', '192.168.1.0/24')).toBe(true)
    expect(ipInCidr('192.168.2.55', '192.168.1.0/24')).toBe(false)
    expect(ipInCidr('10.0.0.1', '10.0.0.0/8')).toBe(true)
    expect(ipInCidr('11.0.0.1', '10.0.0.0/8')).toBe(false)
  })

  it('handles the boundary prefix lengths', () => {
    expect(ipInCidr('1.2.3.4', '1.2.3.4/32')).toBe(true)
    expect(ipInCidr('1.2.3.5', '1.2.3.4/32')).toBe(false)
    expect(ipInCidr('203.0.113.9', '0.0.0.0/0')).toBe(true)
  })

  it('does not overflow on high addresses', () => {
    // A signed-shift bug here silently mismatches everything above 128.x.
    expect(ipInCidr('255.255.255.255', '255.255.255.0/24')).toBe(true)
    expect(ipInCidr('216.73.216.10', '216.73.216.0/22')).toBe(true)
    expect(ipInCidr('216.73.220.10', '216.73.216.0/22')).toBe(false)
  })
})

describe('CIDR matching — IPv6', () => {
  it('matches compressed and expanded forms alike', () => {
    expect(ipInCidr('2001:db8::1', '2001:db8::/32')).toBe(true)
    expect(ipInCidr('2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::/32')).toBe(true)
    expect(ipInCidr('2001:db9::1', '2001:db8::/32')).toBe(false)
  })

  it('handles /48, the prefix spoor truncates to', () => {
    expect(ipInCidr('2001:db8:1234:5678::1', '2001:db8:1234::/48')).toBe(true)
    expect(ipInCidr('2001:db8:1235:5678::1', '2001:db8:1234::/48')).toBe(false)
  })

  it('handles IPv4-mapped addresses', () => {
    expect(ipInCidr('::ffff:192.168.1.1', '::ffff:192.168.1.0/120')).toBe(true)
  })

  it('strips a zone index rather than failing on it', () => {
    expect(ipInCidr('fe80::1%eth0', 'fe80::/16')).toBe(true)
  })
})

describe('CIDR matching — malformed input (NF-2)', () => {
  it('returns false rather than throwing, because this runs on a request path', () => {
    // An unparseable address must produce `unverified`, never an exception that
    // a fail-open wrapper then has to catch.
    const bad = ['', 'not-an-ip', '999.999.999.999', '1.2.3', '1.2.3.4.5', 'gggg::1', '::1::2']
    for (const ip of bad) {
      expect(() => ipInCidr(ip, '10.0.0.0/8')).not.toThrow()
      expect(ipInCidr(ip, '10.0.0.0/8')).toBe(false)
    }
    expect(ipInCidr('1.2.3.4', 'garbage')).toBe(false)
    expect(ipInCidr('1.2.3.4', '1.2.3.0/99')).toBe(false)
    expect(ipInCidr('1.2.3.4', '1.2.3.0/-1')).toBe(false)
  })

  it('does not match an IPv4 address against an IPv6 range', () => {
    expect(ipInCidr('1.2.3.4', '2001:db8::/32')).toBe(false)
    expect(ipInCidr('2001:db8::1', '1.2.3.0/24')).toBe(false)
  })

  it('ipInAnyCidr short-circuits correctly', () => {
    expect(ipInAnyCidr('10.1.2.3', ['192.168.0.0/16', '10.0.0.0/8'])).toBe(true)
    expect(ipInAnyCidr('172.16.0.1', ['192.168.0.0/16', '10.0.0.0/8'])).toBe(false)
    expect(ipInAnyCidr('10.1.2.3', [])).toBe(false)
  })

  it('isIpv4 discriminates', () => {
    expect(isIpv4('1.2.3.4')).toBe(true)
    expect(isIpv4('2001:db8::1')).toBe(false)
  })
})

describe('IP truncation at source (PRD OWN-3, LG-2)', () => {
  it('truncates IPv4 to /24', () => {
    expect(truncateIp('203.0.113.42')).toBe('203.0.113.0/24')
    expect(truncateIp('  8.8.8.8  ')).toBe('8.8.8.0/24')
  })

  it('truncates IPv6 to /48', () => {
    expect(truncateIp('2001:db8:1234:5678::1')).toBe('2001:db8:1234::/48')
    expect(truncateIp('2001:db8::1')).toBe('2001:db8:0::/48')
  })

  it('returns null rather than a partial value for junk', () => {
    expect(truncateIp(null)).toBeNull()
    expect(truncateIp(undefined)).toBeNull()
    expect(truncateIp('')).toBeNull()
    expect(truncateIp('  ')).toBeNull()
    expect(truncateIp('nonsense')).toBeNull()
  })

  it('never returns the full address', () => {
    const full = '203.0.113.42'
    expect(truncateIp(full)).not.toContain('.42')
  })
})

describe('client IP extraction', () => {
  const h = (map: Record<string, string>) => (n: string) => map[n] ?? null

  it('prefers edge-set headers over the client-appendable one', () => {
    // x-forwarded-for can be forged by the client; cf-connecting-ip cannot.
    expect(clientIpFromHeaders(h({
      'cf-connecting-ip': '1.1.1.1',
      'x-forwarded-for': '9.9.9.9, 2.2.2.2',
    }))).toBe('1.1.1.1')
  })

  it('falls back to the first x-forwarded-for entry', () => {
    expect(clientIpFromHeaders(h({ 'x-forwarded-for': '9.9.9.9, 2.2.2.2' }))).toBe('9.9.9.9')
  })

  it('returns null when nothing is present', () => {
    expect(clientIpFromHeaders(h({}))).toBeNull()
  })
})
