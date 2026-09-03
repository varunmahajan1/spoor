import type { KVNamespaceLike } from './types.js'

/**
 * A KV-backed kill switch probe — PRD NF-4.
 *
 * NF-4 fights NF-1 unless specified precisely, so all three properties matter
 * and each is easy to get wrong:
 *
 *   - the read is cached at the edge (`cacheTtl`), so it is not a round trip
 *     per request;
 *   - `KillSwitch` returns the *cached verdict synchronously* and refreshes in
 *     the background, so the request never awaits this;
 *   - **and the read itself fails open.** A kill switch that can hang the
 *     request path is a worse outage than the one it exists to stop.
 *
 * Set the key to `off` (or `0`, or `false`) to stop collection without a
 * redeploy. Any other value, a missing key, or an unreachable KV means "keep
 * running".
 */
export function kvKillSwitchProbe(
  kv: KVNamespaceLike,
  key = 'spoor:enabled',
  cacheTtlSeconds = 60,
): () => Promise<boolean> {
  return async () => {
    try {
      const value = await kv.get(key, { cacheTtl: cacheTtlSeconds })
      if (value === null) return true
      const v = value.trim().toLowerCase()
      return !(v === 'off' || v === '0' || v === 'false' || v === 'disabled')
    } catch {
      return true // fail open
    }
  }
}
