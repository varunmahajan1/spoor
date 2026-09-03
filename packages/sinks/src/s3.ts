import type { SpoorEvent } from '@spoor/core'
import type { Sink } from './sink.js'
import { signRequest } from './sigv4.js'

export interface S3SinkOptions {
  bucket: string
  /** AWS region, or `auto` for Cloudflare R2. */
  region?: string
  /**
   * Full endpoint. Omit for AWS S3.
   *   Cloudflare R2: https://<account-id>.r2.cloudflarestorage.com
   *   MinIO:         http://localhost:9000
   */
  endpoint?: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /** Key prefix. Default `events`. */
  prefix?: string
  /** Path-style addressing. Forced on when `endpoint` is set. */
  forcePathStyle?: boolean
  timeoutMs?: number
}

/**
 * Writes each batch as one NDJSON object — PRD SN-1, and the sink that makes
 * spoor usable on a platform with an ephemeral filesystem (Vercel, Workers,
 * any container that is replaced on deploy).
 *
 * **R2 speaks the S3 API, so this one implementation covers both.** Set
 * `endpoint` to your R2 endpoint and `region: 'auto'`.
 *
 * One object per batch rather than an append: object stores have no append, and
 * read-modify-write from several concurrent isolates would lose events. The
 * roll-up reads the whole prefix and deduplicates on `event_id`, so many small
 * objects cost nothing analytically.
 */
export function s3Sink(options: S3SinkOptions): Sink {
  const region = options.region ?? 'us-east-1'
  const prefix = (options.prefix ?? 'events').replace(/^\/+|\/+$/g, '')
  const timeoutMs = options.timeoutMs ?? 5_000
  const pathStyle = options.forcePathStyle ?? Boolean(options.endpoint)

  const base = options.endpoint
    ? new URL(options.endpoint)
    : new URL(`https://${options.bucket}.s3.${region}.amazonaws.com`)

  return {
    name: `s3(${options.bucket})`,
    async write(events: readonly SpoorEvent[]) {
      if (events.length === 0) return

      // Partition by the event's own date, not by today's, so a late batch
      // lands in the partition it belongs to.
      const byDay = new Map<string, SpoorEvent[]>()
      for (const e of events) {
        const day = e.ts.slice(0, 10)
        const list = byDay.get(day) ?? []
        list.push(e)
        byDay.set(day, list)
      }

      for (const [day, batch] of byDay) {
        const body = batch.map((e) => JSON.stringify(e)).join('\n') + '\n'
        // The first event's id names the object, so a retried batch overwrites
        // itself rather than creating a second copy.
        const key = `${prefix}/${day}/${batch[0]!.event_id}.ndjson`
        const url = new URL(base)
        url.pathname = pathStyle ? `/${options.bucket}/${key}` : `/${key}`

        const headers = await signRequest({
          method: 'PUT',
          url,
          body,
          region,
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
          sessionToken: options.sessionToken,
        })

        const res = await fetch(url, {
          method: 'PUT',
          headers: { ...headers, 'content-type': 'application/x-ndjson' },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) {
          throw new Error(`s3 sink: ${res.status} ${res.statusText} for ${key}`)
        }
      }
    },
  }
}
