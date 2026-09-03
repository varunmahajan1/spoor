/**
 * spoor's request-path adapter for any fetch-shaped runtime.
 *
 * Typed against the standard `Request`/`Response` interfaces, so it depends on
 * no framework and no host: Vercel middleware, Netlify Edge, Deno Deploy, Bun
 * and a plain Node fetch server all use this same code. `waitUntil` arrives as
 * an argument rather than an import, which is what keeps `@vercel/functions`
 * (or any host SDK) out of this package entirely.
 *
 * The framework only decides *what to ignore*; the host decides *where
 * collection happens*. That split is why there is one adapter and a set of
 * presets rather than one package per framework — see `presets.ts`.
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
import { preset } from './presets.js'

export interface SpoorOptions {
  sink: Sink
  /**
   * Where this row was collected. Defaults to `vercel-middleware`.
   *
   * Set it explicitly on any other host. A row's surface is what makes it
   * comparable to rows from elsewhere, so a wrong value is not cosmetic — it
   * silently attributes data to a collection point it never came from.
   * A preset supplies this for you.
   */
  surface?: Surface
  /** PRD §8.1 — off by default; the column exists, the value does not. */
  retainQuery?: boolean
  /** PRD LG-3 — drop human rows at source. On by default: smaller storage, and
   *  materially smaller legal surface. No core report needs them. */
  dropHumans?: boolean
  /** Skip paths that say nothing about crawler behaviour. */
  ignore?: (path: string) => boolean
  batch?: { maxEvents?: number; maxWaitMs?: number }
  /**
   * Accepted and ignored by the recorder. It exists so a preset can be spread
   * into these options in one call and still feed the host's route config:
   *
   * ```ts
   * const site = preset('vite')
   * const spoor = createRecorder({ sink, ...site })
   * export const config = { matcher: site.matcher }
   * ```
   */
  matcher?: string[]
  killSwitch?: KillSwitchOptions
  /** NF-7. Without this a fail-open surface produces a clean-looking dataset
   *  with holes in it, which is worse than an outage because nobody notices. */
  onError?: (error: unknown) => void
}

/**
 * Used when no `ignore` is given: the union of every framework preset's paths.
 *
 * A union rather than one framework's list, because the previous Next-only
 * default silently recorded every Vite bundle under `/assets/` as a page fetch.
 * Cross-framework prefixes do not collide in practice, so the union costs a
 * Next site nothing and saves a Vite site from a corrupted dataset.
 *
 * Pass a preset instead when you also want a route matcher, which is what keeps
 * asset requests from being billed invocations on Vercel.
 */
const DEFAULT_IGNORE = (path: string): boolean =>
  preset('next').ignore(path) || preset('vite').ignore(path) || preset('astro').ignore(path)

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
  /**
   * Leave unset on a before-cache surface, which is every host middleware.
   *
   * The schema carries `cache_status` because a response served from cache
   * *without* invoking the logger is an unlogged visit. Here the inverse holds:
   * middleware runs before the cache, so at record time the status does not
   * exist yet — `x-vercel-cache` is a response header. Recording `unknown` is
   * the honest value; inferring one would invent a fact.
   */
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
  const ignore = options.ignore ?? DEFAULT_IGNORE

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
          surface: options.surface ?? 'vercel-middleware',
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
export { preset, PRESET_NAMES } from './presets.js'
export type { Preset, FrameworkPreset } from './presets.js'
