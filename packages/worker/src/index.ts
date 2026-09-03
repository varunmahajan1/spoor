/**
 * spoor's Cloudflare Worker adapter — PRD CS-1.
 *
 * This is the only route to standard Shopify. Shopify exposes no first-party
 * way to see storefront requests (apps are admin-side, pixels are client-side
 * and AI crawlers run no JavaScript, Liquid cannot read the user agent), so the
 * only position left is a Cloudflare zone in front of the storefront via
 * Orange-to-Orange. See docs/DESIGN.md §2 for what that costs and who
 * disclaims it.
 *
 * Two things make this adapter different from host middleware rather than a
 * copy of it:
 *
 *   1. It runs *around* the origin fetch, so `status`, `bytes`, `duration_ms`
 *      and `cache_status` are real values rather than `unknown`. On the
 *      middleware surface the response does not exist yet at record time.
 *   2. A Worker that throws returns a Cloudflare error page instead of the
 *      origin response. `passThroughOnException()` is what prevents that, and
 *      this adapter calls it before anything else.
 *
 * The recorder itself is `@spoor/middleware`'s, not a second implementation —
 * one classifier, one verifier, one schema (PRD AR-1).
 */
import { createRecorder, record, preset, KillSwitch } from '@spoor/middleware'
import type { Recorder, SpoorOptions } from '@spoor/middleware'
import type { CacheStatus } from '@spoor/core'
import type { CfRequest, ExecutionContextLike } from './types.js'

export interface WorkerOptions extends Omit<SpoorOptions, 'surface'> {
  /**
   * Paths never recorded and never inspected.
   *
   * Defaults to checkout. PRD SH-7: PCI scope is not ours to reason about, and
   * a crawler has never requested a checkout page — so there is no measurement
   * lost by staying away from it. Cloudflare's O2O routing disables Workers on
   * `/checkout` anyway; this makes the same rule hold on every other origin.
   */
  never?: (path: string) => boolean
}

const DEFAULT_NEVER = (path: string): boolean =>
  path === '/checkout' || path.startsWith('/checkout/') || path.startsWith('/checkouts/')

/** Cloudflare's `cf-cache-status` in the schema's vocabulary. */
function cacheStatusFrom(header: string | null): CacheStatus {
  switch ((header ?? '').toUpperCase()) {
    case 'HIT': return 'hit'
    case 'MISS':
    case 'EXPIRED': return 'miss'
    case 'BYPASS':
    case 'DYNAMIC': return 'bypass'
    case 'REVALIDATED':
    case 'UPDATING': return 'revalidated'
    default: return 'unknown'
  }
}

function pathOf(url: string): string {
  try { return new URL(url).pathname } catch { return '/' }
}

export interface SpoorWorker {
  fetch(request: CfRequest, env: unknown, ctx: ExecutionContextLike): Promise<Response>
}

/**
 * Builds a Worker that proxies to the origin and records what passed through.
 *
 * ```ts
 * import { createWorker } from '@spoor/worker'
 * import { r2BindingSink } from '@spoor/sinks'
 *
 * export default createWorker((env: Env) => ({
 *   sink: r2BindingSink({ bucket: env.SPOOR_BUCKET }),
 * }))
 * ```
 *
 * The options are built per-isolate from `env`, because bindings only exist
 * once a request arrives. The recorder is then reused for the isolate's life,
 * which is what makes batching (NF-3) work at all.
 */
export function createWorker<Env = unknown>(
  configure: (env: Env) => WorkerOptions,
): SpoorWorker {
  let recorder: Recorder | null = null
  let never: (path: string) => boolean = DEFAULT_NEVER
  let onError: (e: unknown) => void = () => {}

  return {
    async fetch(request: CfRequest, env: unknown, ctx: ExecutionContextLike): Promise<Response> {
      // NF-2, first and unconditionally. Everything below may throw; none of it
      // may change what the visitor receives.
      try { ctx.passThroughOnException() } catch { /* absent in some test harnesses */ }

      const path = pathOf(request.url)

      try {
        if (recorder === null) {
          const options = configure(env as Env)
          never = options.never ?? DEFAULT_NEVER
          onError = options.onError ?? (() => {})
          recorder = createRecorder({
            ...preset('none', 'cloudflare-worker'),
            ...options,
            surface: 'cloudflare-worker',
          })
        }
      } catch (error) {
        // A misconfigured sink must not take the site down with it.
        try { onError(error) } catch { /* ignore */ }
        return fetch(request)
      }

      if (never(path)) return fetch(request)

      const started = Date.now()
      const response = await fetch(request)

      try {
        const length = response.headers.get('content-length')
        record(recorder, request, (p) => ctx.waitUntil(p), {
          status: response.status,
          bytes: length === null ? null : Number(length),
          durationMs: Date.now() - started,
          // Real, not `unknown`: this surface sees the response.
          cacheStatus: cacheStatusFrom(response.headers.get('cf-cache-status')),
          // VF-7: opportunistic. Populated only on zones entitled to Bot
          // Management, which is why VF-1 was withdrawn and every surface
          // carries the bundled range list instead.
          ...(request.cf?.botManagement?.verifiedBot !== undefined
            ? { cfVerifiedBot: request.cf.botManagement.verifiedBot }
            : {}),
        })
      } catch (error) {
        try { onError(error) } catch { /* ignore */ }
      }

      // The origin's response, untouched.
      return response
    },
  }
}

export { kvKillSwitchProbe } from './kill-switch.js'
export type {
  ExecutionContextLike, CfRequest, KVNamespaceLike, R2BucketLike,
  IncomingRequestCfProperties,
} from './types.js'
export { KillSwitch }
