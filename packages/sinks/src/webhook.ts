import type { SpoorEvent } from '@spoor/core'
import type { Sink } from './sink.js'

export interface WebhookSinkOptions {
  url: string
  headers?: Record<string, string>
  timeoutMs?: number
}

/**
 * POSTs a batch as NDJSON. Runtime-agnostic — uses only `fetch`, so it works in
 * a Worker, in middleware and in Node.
 */
export function webhookSink(options: WebhookSinkOptions): Sink {
  const timeoutMs = options.timeoutMs ?? 3_000
  return {
    name: `webhook(${options.url})`,
    async write(events: readonly SpoorEvent[]) {
      if (events.length === 0) return
      const body = events.map((e) => JSON.stringify(e)).join('\n')
      const res = await fetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson', ...options.headers },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new Error(`sink responded ${res.status}`)
    },
  }
}
