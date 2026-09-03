/**
 * Event identity — PRD §8.1, PI-6.
 *
 * The roll-up dedupes on `event_id`, so the id has to be right for the surface
 * that produced it. There are two cases and they need different answers:
 *
 *   Push surfaces (middleware, Worker) emit once per request. A random,
 *   time-ordered id is correct: a retried *batch* carries the same ids, so the
 *   roll-up collapses it.
 *
 *   Log-derived surfaces (Vector, a drain receiver) can re-ship the same log
 *   line from a new process with no memory of the first attempt. A random id
 *   would mint a fresh identity for an event already stored and inflate the
 *   crawl count — the number being reported. Those surfaces must use the
 *   content hash so identity is a property of the event, not of the emit.
 */

const HEX = '0123456789abcdef'

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  crypto.getRandomValues(out)
  return out
}

function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += HEX[b >> 4]! + HEX[b & 15]!
  return s
}

/**
 * UUIDv7: 48-bit big-endian millisecond timestamp, version 7, variant 10.
 * Time-ordered, so Parquet row groups sort usefully and range scans by time
 * stay cheap. For push surfaces.
 */
export function newEventId(now: number = Date.now()): string {
  const b = randomBytes(16)
  const ts = BigInt(now)
  b[0] = Number((ts >> 40n) & 0xffn)
  b[1] = Number((ts >> 32n) & 0xffn)
  b[2] = Number((ts >> 24n) & 0xffn)
  b[3] = Number((ts >> 16n) & 0xffn)
  b[4] = Number((ts >> 8n) & 0xffn)
  b[5] = Number(ts & 0xffn)
  b[6] = (b[6]! & 0x0f) | 0x70 // version 7
  b[8] = (b[8]! & 0x3f) | 0x80 // variant 10
  const h = hex(b)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export interface EventIdParts {
  ts: string
  ip_prefix: string | null
  path: string
  user_agent: string
  status: number
}

/**
 * Deterministic id for replayable sources: SHA-256 over the tuple named in the
 * PRD schema. Two shipments of one log line produce one id, so PI-6 holds
 * across a re-run of the shipper.
 *
 * Async because SubtleCrypto is. That is fine — log-derived surfaces are not on
 * a request path, so NF-1 does not apply to them.
 */
export async function deterministicEventId(p: EventIdParts): Promise<string> {
  const material = [p.ts, p.ip_prefix ?? '', p.path, p.user_agent, String(p.status)].join('|')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  return hex(new Uint8Array(digest)).slice(0, 32)
}
