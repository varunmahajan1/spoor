/**
 * `spoor ingest` — turns log lines into schema rows. PRD CS-2.
 *
 * Vector's job is transport and nothing else: it tails an access log, parses
 * it, and writes a reduced row. It does not classify and it does not verify,
 * because the classifier is a versioned ruleset (AR-6) and reimplementing it in
 * VRL would be a second copy that drifts — the exact failure CL-1 exists to
 * prevent. Vector is shipped as a config, not as software.
 *
 * **Run this on the log host.** That is what keeps LG-2 true: the full IP is
 * read here, used for range verification, and truncated before anything is
 * written, so it never leaves the operator's infrastructure. Shipping the full
 * address to a central ingest first would defeat the point.
 *
 * Identity is a content hash, not a UUID (PI-6). A restarted shipper re-reads
 * lines it already sent and has no memory of having sent them, so a random id
 * would mint a fresh identity for an event already stored and inflate the crawl
 * count — the number being reported.
 *
 * **The cost of that choice, stated rather than hidden.** The hash covers
 * `ts | ip_prefix | path | user_agent | status`, so two *genuinely distinct*
 * requests that agree on all five collapse into one row. In a real access log
 * that needs the same crawler, in the same second, from the same /24, fetching
 * the same path, with the same status — uncommon but not impossible for a fast
 * crawler hammering one URL. The exposure is undercounting a burst, never
 * overcounting, and it applies only to log-derived surfaces: push surfaces mint
 * a UUIDv7 per request and cannot collide.
 *
 * Widening the hash to include `bytes` and `duration_ms` would separate almost
 * all of those while staying replay-safe. It is not done here because the hash
 * inputs are a schema-level decision, not an implementation detail.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { normaliseReplayable } from '@spoor/core'
import type { SpoorEvent, Surface } from '@spoor/core'
import type { Sink } from '@spoor/sinks'

/** What a Vector config emits. Every field optional but `user_agent`. */
export interface RawLogRow {
  ts?: string
  host?: string
  method?: string
  url?: string
  path?: string
  status?: number | string
  bytes?: number | string | null
  duration_ms?: number | string | null
  user_agent?: string | null
  referer?: string | null
  /** Full address. Read here, never written — see the module comment. */
  ip?: string | null
}

export interface IngestOptions {
  surface?: Surface
  retainQuery?: boolean
  /** Keep human rows. Off by default (LG-3). */
  keepHumans?: boolean
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '' || v === '-') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function rowToEvent(row: RawLogRow, options: IngestOptions = {}): Promise<SpoorEvent> {
  return normaliseReplayable({
    host: row.host ?? '',
    method: row.method ?? 'GET',
    url: row.url ?? row.path ?? '/',
    status: num(row.status) ?? 0,
    userAgent: row.user_agent ?? '',
    surface: options.surface ?? 'vector',
    ip: row.ip ?? null,
    referer: row.referer ?? null,
    bytes: num(row.bytes),
    durationMs: num(row.duration_ms),
    // A log line records what the origin served. Whether an edge cache answered
    // some other request without reaching the origin is not visible from here,
    // so `unknown` is the honest value.
    cacheStatus: 'unknown',
    retainQuery: options.retainQuery ?? false,
    ...(row.ts ? { at: Date.parse(row.ts) } : {}),
  })
}

export interface IngestResult {
  read: number
  written: number
  skippedHuman: number
  malformed: number
}

/** Reads NDJSON from a file or every `.ndjson` in a directory. */
export async function ingest(
  source: string, sink: Sink, options: IngestOptions = {},
): Promise<IngestResult> {
  const files: string[] = []
  try {
    const entries = await readdir(source)
    for (const e of entries) if (e.endsWith('.ndjson') || e.endsWith('.json')) files.push(join(source, e))
  } catch {
    files.push(source) // not a directory
  }

  const result: IngestResult = { read: 0, written: 0, skippedHuman: 0, malformed: 0 }
  const batch: SpoorEvent[] = []

  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      result.read++
      let row: RawLogRow
      try {
        row = JSON.parse(line) as RawLogRow
      } catch {
        // One unparseable line must not abort a night's spool.
        result.malformed++
        continue
      }
      const event = await rowToEvent(row, options)
      if (!options.keepHumans && event.crawler_bucket === 'human') { result.skippedHuman++; continue }
      batch.push(event)
      if (batch.length >= 500) { await sink.write(batch.splice(0)) }
    }
  }
  if (batch.length > 0) await sink.write(batch)
  result.written = result.read - result.skippedHuman - result.malformed
  return result
}
