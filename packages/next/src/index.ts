/**
 * spoor for Next.js middleware — PRD CS-3, the reference surface.
 *
 * Deliberately typed against the standard `Request`/`Response` interfaces
 * rather than `NextRequest`, so this package needs no dependency on Next and
 * works unchanged in any fetch-shaped runtime.
 *
 * The non-negotiables, all from PRD §11:
 *   NF-1  logging never blocks the response
 *   NF-2  a thrown logger serves the request normally
 *   NF-3  batched, never a per-request round trip
 *   NF-4  killable without a redeploy, and the switch itself fails open
 *   NF-7  the operator can see the adapter's own error rate
 */
import { clientIpFromHeaders, normalise } from '@spoor/core'
import type { CacheStatus, Surface } from '@spoor/core'
import { Batcher, safeSink } from '@spoor/sinks'
import type { Sink } from '@spoor/sinks'
import { KillSwitch } from './kill-switch.js'
import type { KillSwitchOptions } from './kill-switch.js'

export interface SpoorOptions {
  sink: Sink
  /** Defaults to `next-middleware`. */
  surface?: Surface
  /** PRD §8.1 — off by default; the column exists, the value does not. */
  retainQuery?: boolean
  /** PRD LG-3 — drop human rows at source. On by default: smaller storage, and
   *  materially smaller legal surface. No core report needs them. */
  dropHumans?: boolean
  /** Skip paths that say nothing about crawler behaviour. */
  ignore?: (path: string) => boolean
  batch?: { maxEvents?: number; maxWaitMs?: number }
  killSwitch?: KillSwitchOptions
  /** NF-7. Without this a fail-open surface produces a clean-looking dataset
   *  with holes in it, which is worse than an outage because nobody notices. */
  onError?: (error: unknown) => void
}

const DEFAULT_IGNORE = /^\/(_next\/static|_next\/image|favicon\.ico|__nextjs)/

export interface Recorder {
  /** Fire-and-forget. Returns a promise only when this call triggered a flush;
   *  hand that to `waitUntil` so the platform keeps the isolate alive. */
  record(request: Request, meta?: RecordMeta): Promise<void> | undefined
  flush(): Promise<void>
}

export interface RecordMeta {
  status?: number
  bytes?: number | null
  durationMs?: number | null
  cacheStatus?: CacheStatus
  /** PRD VF-7 — present only on Cloudflare zones entitled to Bot Management. */
  cfVerifiedBot?: boolean
}

export function createRecorder(options: SpoorOptions): Recorder {
  const onError = options.onError ?? (() => {})
  const sink = safeSink(options.sink, { onError: (e) => onError(e) })
  const batcher = new Batcher(sink, {
    maxEvents: options.batch?.maxEvents ?? 25,
    maxWaitMs: options.batch?.maxWaitMs ?? 5_000,
    onDrop: (n) => onError(new Error(`spoor dropped ${n} buffered events (overflow)`)),
  })
  const kill = new KillSwitch(options.killSwitch ?? {})
  const dropHumans = options.dropHumans ?? true
  const ignore = options.ignore ?? ((p: string) => DEFAULT_IGNORE.test(p))

  return {
    record(request, meta = {}) {
      // Everything below is inside one try: NF-2 says a thrown logger must not
      // change what the visitor receives, and "fail-open as an intention" has
      // been shipped as an error page more than once.
      try {
        if (!kill.enabled()) return undefined

        const url = request.url ?? '/'
        const path = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0] ?? '/'
        if (ignore(path)) return undefined

        const h = (n: string) => request.headers.get(n)
        const userAgent = h('user-agent')

        const event = normalise({
          host: h('host') ?? (url.startsWith('http') ? new URL(url).host : ''),
          method: request.method ?? 'GET',
          url,
          status: meta.status ?? 200,
          userAgent,
          surface: options.surface ?? 'next-middleware',
          ip: clientIpFromHeaders(h),
          referer: h('referer'),
          bytes: meta.bytes ?? null,
          durationMs: meta.durationMs ?? null,
          cacheStatus: meta.cacheStatus ?? 'unknown',
          cfVerifiedBot: meta.cfVerifiedBot,
          retainQuery: options.retainQuery ?? false,
        })

        if (dropHumans && event.crawler_bucket === 'human') return undefined

        return batcher.add(event)
      } catch (error) {
        onError(error)
        return undefined
      }
    },

    async flush() {
      try { await batcher.flush() } catch (error) { onError(error) }
    },
  }
}

export type WaitUntil = (promise: Promise<unknown>) => void

/**
 * Records a request without ever letting the logger affect the response.
 *
 * Pass `waitUntil` (from `next/server`'s `after`, or the platform's execution
 * context) so a triggered flush completes after the response is sent — NF-1.
 */
export function record(recorder: Recorder, request: Request, waitUntil?: WaitUntil, meta?: RecordMeta): void {
  try {
    const pending = recorder.record(request, meta)
    if (!pending) return
    if (waitUntil) waitUntil(pending)
    else void pending.catch(() => {})
  } catch {
    /* NF-2 */
  }
}

export { KillSwitch } from './kill-switch.js'
export type { KillSwitchOptions, KillSwitchProbe } from './kill-switch.js'
