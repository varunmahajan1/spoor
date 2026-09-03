/**
 * The kill switch — PRD NF-4.
 *
 * NF-4 fights NF-1 unless it is specified precisely: the check is cached in the
 * isolate behind a short TTL, and **the check itself fails open**. A kill switch
 * that can hang the request path is a worse outage than the one it exists to
 * stop, so a slow or throwing probe is treated as "keep running", never as
 * "stop" and never as "wait".
 */
export type KillSwitchProbe = () => boolean | Promise<boolean>

export interface KillSwitchOptions {
  probe?: KillSwitchProbe
  ttlMs?: number
  timeoutMs?: number
}

export class KillSwitch {
  private cached = true
  private checkedAt = 0
  private inFlight: Promise<void> | null = null
  private readonly ttlMs: number
  private readonly timeoutMs: number

  constructor(private readonly options: KillSwitchOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000
    this.timeoutMs = options.timeoutMs ?? 1_000
  }

  /**
   * Synchronous by design. Returns the cached verdict immediately and refreshes
   * in the background, so the request never waits on the probe.
   */
  enabled(now: number = Date.now()): boolean {
    if (!this.options.probe) return true
    if (now - this.checkedAt >= this.ttlMs && this.inFlight === null) {
      this.checkedAt = now
      this.inFlight = this.refresh().finally(() => { this.inFlight = null })
    }
    return this.cached
  }

  private async refresh(): Promise<void> {
    try {
      const verdict = await Promise.race([
        Promise.resolve(this.options.probe!()),
        new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(true), this.timeoutMs)
          ;(t as unknown as { unref?: () => void }).unref?.()
        }),
      ])
      this.cached = verdict !== false
    } catch {
      this.cached = true // fail open
    }
  }
}
