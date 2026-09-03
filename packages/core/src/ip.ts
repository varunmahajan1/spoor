/**
 * IP truncation at source — PRD OWN-3, LG-2.
 *
 * The full IP never leaves the operator's infrastructure. What is retained is
 * a prefix wide enough to re-check published-range membership later (VF-4) and
 * narrow enough that the row is not a visitor record.
 *
 * PRD §12.2 states the consequence plainly and this comment repeats it so it is
 * not lost: a /24 prefix is still identifying in a small population. These rows
 * are pseudonymised, not anonymous. Do not describe them as anonymous.
 */
import { isIpv4 } from './cidr.js'

const IPV4_BITS = 24
const IPV6_BITS = 48

/** Truncates to /24 (IPv4) or /48 (IPv6). Returns null for unparseable input. */
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  const addr = ip.trim()
  if (!addr) return null

  if (isIpv4(addr)) {
    const parts = addr.split('.')
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/${IPV4_BITS}`
  }

  // IPv6: keep the first three hextets (48 bits).
  const bare = addr.replace(/^\[|\]$/g, '').split('%')[0] ?? ''
  if (!bare.includes(':')) return null
  const halves = bare.split('::')
  const head = (halves[0] ?? '').split(':').filter((s) => s !== '')
  const kept: string[] = []
  for (let i = 0; i < IPV6_BITS / 16; i++) kept.push(head[i] ?? '0')
  return `${kept.join(':')}::/${IPV6_BITS}`
}

/**
 * Best-effort client IP from proxy headers, most trustworthy first.
 *
 * Header order matters: `cf-connecting-ip` and `x-real-ip` are set by the edge
 * and cannot be spoofed by the client, whereas `x-forwarded-for` is a
 * client-appendable list, so only its first entry is meaningful and only when
 * nothing better is present.
 */
export function clientIpFromHeaders(get: (name: string) => string | null | undefined): string | null {
  for (const h of ['cf-connecting-ip', 'x-real-ip', 'x-vercel-forwarded-for', 'true-client-ip']) {
    const v = get(h)
    if (v) return v.trim()
  }
  const xff = get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  return null
}
