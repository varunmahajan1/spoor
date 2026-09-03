/**
 * CIDR membership for IPv4 and IPv6, with no dependencies.
 *
 * This runs inside a Cloudflare Worker and inside Next.js middleware, so it
 * must not pull in a Node built-in or a package (PRD AR-1: core carries zero
 * runtime dependencies). It is implemented once here and consumed by every
 * adapter rather than per-surface (VF-6) — three copies of a range matcher is
 * three drift surfaces.
 */

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    out = (out << 8) | n
  }
  return out >>> 0
}

/** Expands an IPv6 address (including `::` and IPv4-mapped forms) to a BigInt. */
function ipv6ToBigInt(ip: string): bigint | null {
  let addr = ip
  // Strip a zone index (fe80::1%eth0) and any brackets.
  const zone = addr.indexOf('%')
  if (zone !== -1) addr = addr.slice(0, zone)
  addr = addr.replace(/^\[|\]$/g, '')

  // IPv4-mapped: ::ffff:1.2.3.4 — convert the tail to two hextets.
  const v4 = addr.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/)
  if (v4) {
    const asInt = ipv4ToInt(v4[2]!)
    if (asInt === null) return null
    const hi = (asInt >>> 16).toString(16)
    const lo = (asInt & 0xffff).toString(16)
    addr = `${v4[1]}${hi}:${lo}`
  }

  const halves = addr.split('::')
  if (halves.length > 2) return null

  const head = halves[0] ? halves[0]!.split(':').filter((s) => s !== '') : []
  const tail = halves.length === 2 && halves[1] ? halves[1]!.split(':').filter((s) => s !== '') : []
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 && head.length !== 8) return null
  if (fill < 0) return null

  const hextets = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail]
  if (hextets.length !== 8) return null

  let out = 0n
  for (const h of hextets) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null
    out = (out << 16n) | BigInt(parseInt(h, 16))
  }
  return out
}

export function isIpv4(ip: string): boolean {
  return ipv4ToInt(ip) !== null
}

/**
 * True when `ip` falls inside `cidr`. Returns false — never throws — on any
 * malformed input, because this sits on a request path where NF-2 (fail-open)
 * applies: an unparseable address must produce `unverified`, not an exception.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.lastIndexOf('/')
  if (slash === -1) return false
  const base = cidr.slice(0, slash)
  const bits = Number(cidr.slice(slash + 1))
  if (!Number.isInteger(bits) || bits < 0) return false

  const v4Ip = ipv4ToInt(ip)
  const v4Base = ipv4ToInt(base)
  if (v4Ip !== null && v4Base !== null) {
    if (bits > 32) return false
    if (bits === 0) return true
    const mask = bits === 32 ? 0xffffffff : ~((1 << (32 - bits)) - 1) >>> 0
    return ((v4Ip & mask) >>> 0) === ((v4Base & mask) >>> 0)
  }

  const v6Ip = ipv6ToBigInt(ip)
  const v6Base = ipv6ToBigInt(base)
  if (v6Ip !== null && v6Base !== null) {
    if (bits > 128) return false
    const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits)
    return (v6Ip & mask) === (v6Base & mask)
  }

  return false
}

export function ipInAnyCidr(ip: string, cidrs: readonly string[]): boolean {
  for (const c of cidrs) if (ipInCidr(ip, c)) return true
  return false
}
