import type { SpoorEvent } from '@spoor/core'
import type { Sink } from './sink.js'

/** An R2 bucket binding, structurally — no Workers types needed. */
export interface R2BucketLike {
  put(key: string, value: string): Promise<unknown>
}

export interface R2BindingSinkOptions {
  bucket: R2BucketLike
  /** Key prefix. Default `events`. */
  prefix?: string
}

/**
 * Writes through a Cloudflare R2 *binding* rather than the S3 API.
 *
 * Prefer this inside a Worker. PRD PI-1: a Worker and its bucket are the same
 * vendor, so a binding is a short in-network path with no egress charge, no
 * credentials in the environment, and no SigV4 signing on the request path.
 * `s3Sink` remains the right choice from anywhere else, including from the CLI
 * reading the same bucket back.
 */
export function r2BindingSink(options: R2BindingSinkOptions): Sink {
  const prefix = (options.prefix ?? 'events').replace(/^\/+|\/+$/g, '')
  return {
    name: 'r2-binding',
    async write(events: readonly SpoorEvent[]) {
      if (events.length === 0) return
      // Partition by the event's own date, not today's, so a late batch lands
      // in the partition it belongs to.
      const byDay = new Map<string, SpoorEvent[]>()
      for (const e of events) {
        const day = e.ts.slice(0, 10)
        const list = byDay.get(day) ?? []
        list.push(e)
        byDay.set(day, list)
      }
      for (const [day, batch] of byDay) {
        // Named by the first event's id, so a retried batch overwrites itself
        // rather than creating a second copy of the same rows.
        const key = `${prefix}/${day}/${batch[0]!.event_id}.ndjson`
        await options.bucket.put(key, batch.map((e) => JSON.stringify(e)).join('\n') + '\n')
      }
    },
  }
}
