/**
 * Structural types for the Workers runtime.
 *
 * Declared here rather than depending on `@cloudflare/workers-types`, so this
 * package keeps the same zero-dependency posture as the rest of the adapters
 * and can be unit-tested in plain Node without a Workers shim.
 */

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
  /**
   * The mechanism NF-2 names. Without it, a Worker that throws returns a
   * Cloudflare 1101 error page **instead of the origin response** — the visitor
   * sees an error caused by the logger. "Fail-open" as an intention has been
   * shipped as a 1101 more than once, so this adapter calls it before doing
   * anything else and does not offer a way to skip it.
   */
  passThroughOnException(): void
}

/** The subset of Cloudflare's request metadata this adapter reads. */
export interface IncomingRequestCfProperties {
  botManagement?: {
    /** Enterprise Bot Management only — see VF-1's withdrawal in docs/DESIGN.md. */
    verifiedBot?: boolean
    verifiedBotCategory?: string
  }
  colo?: string
}

export interface CfRequest extends Request {
  cf?: IncomingRequestCfProperties
}

/** A KV namespace, structurally. Used only for the kill switch. */
export interface KVNamespaceLike {
  get(key: string, options?: { cacheTtl?: number }): Promise<string | null>
}

/** An R2 bucket binding, structurally. */
export interface R2BucketLike {
  put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<unknown>
}
