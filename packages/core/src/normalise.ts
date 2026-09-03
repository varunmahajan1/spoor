/**
 * Turns a request-shaped input into a SpoorEvent — the one place the schema is
 * assembled, shared by every adapter (PRD AR-1).
 */
import { classify } from './classifier.js'
import { verify } from './verify.js'
import { truncateIp } from './ip.js'
import { newEventId, deterministicEventId } from './event-id.js'
import type { CacheStatus, SpoorEvent, Surface } from './schema.js'

export interface NormaliseInput {
  host: string
  method: string
  /** May include a query string; it is split off here. */
  url: string
  status: number
  userAgent: string | null | undefined
  surface: Surface
  ip?: string | null
  referer?: string | null
  bytes?: number | null
  durationMs?: number | null
  cacheStatus?: CacheStatus
  cfVerifiedBot?: boolean | undefined
  /** Off by default (PRD §8.1): the column always exists, the value does not. */
  retainQuery?: boolean
  at?: number
}

function splitPath(url: string): { path: string; query: string | null } {
  // Accepts a full URL or a bare path. Never throws: this is on a request path.
  let rest = url
  const schemeEnd = rest.indexOf('://')
  if (schemeEnd !== -1) {
    const afterHost = rest.indexOf('/', schemeEnd + 3)
    rest = afterHost === -1 ? '/' : rest.slice(afterHost)
  }
  const hash = rest.indexOf('#')
  if (hash !== -1) rest = rest.slice(0, hash)
  const q = rest.indexOf('?')
  if (q === -1) return { path: rest || '/', query: null }
  return { path: rest.slice(0, q) || '/', query: rest.slice(q + 1) || null }
}

function base(input: NormaliseInput) {
  const { path, query } = splitPath(input.url)
  const ua = input.userAgent ?? ''
  const classification = classify(ua)
  const verification = verify({
    bucket: classification.bucket,
    ip: input.ip ?? null,
    cfVerifiedBot: input.cfVerifiedBot,
  })

  return {
    ts: new Date(input.at ?? Date.now()).toISOString(),
    host: input.host,
    method: input.method,
    path,
    query: input.retainQuery ? query : null,
    status: input.status,
    bytes: input.bytes ?? null,
    duration_ms: input.durationMs ?? null,
    cache_status: input.cacheStatus ?? 'unknown',
    user_agent: ua,
    crawler_bucket: classification.bucket,
    crawler_purpose: classification.purpose,
    crawler_verified: verification.verified,
    verified_by: verification.by,
    classifier_version: classification.version,
    referer: input.referer ?? null,
    ip_prefix: truncateIp(input.ip),
    surface: input.surface,
  } satisfies Omit<SpoorEvent, 'event_id'>
}

/** For push surfaces: one request, one emit, time-ordered id. */
export function normalise(input: NormaliseInput): SpoorEvent {
  return { event_id: newEventId(input.at ?? Date.now()), ...base(input) }
}

/**
 * For log-derived surfaces, where the same line can be shipped twice by a
 * restarted process. Identity is a property of the event, so PI-6 survives a
 * replay of the shipper.
 */
export async function normaliseReplayable(input: NormaliseInput): Promise<SpoorEvent> {
  const b = base(input)
  const event_id = await deterministicEventId({
    ts: b.ts, ip_prefix: b.ip_prefix, path: b.path,
    user_agent: b.user_agent, status: b.status,
  })
  return { event_id, ...b }
}
