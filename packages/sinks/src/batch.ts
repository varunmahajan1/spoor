import type { SpoorEvent } from '@spoor/core'
import type { Sink } from './sink.js'

export interface BatcherOptions {
  maxEvents?: number
  maxWaitMs?: number
  /** Hard ceiling on buffered events. Past this the oldest are dropped rather
   *  than allowed to grow without bound — an adapter must never become the
   *  reason a process runs out of memory. */
  maxBuffer?: number
  onDrop?: (dropped: number, reason: 'overflow') => void
}

/**
 * Accumulates events and flushes on size or age — PRD NF-3.
 *
 * `add` is synchronous and returns nothing: the caller is on a request path and
 * must not await the sink. The returned promise from a triggered flush is
 * handed to `waitUntil` by the adapter, not to the request.
 */
export class Batcher {
  private buf: SpoorEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly maxEvents: number
  private readonly maxWaitMs: number
  private readonly maxBuffer: number

  constructor(private readonly sink: Sink, private readonly options: BatcherOptions = {}) {
    this.maxEvents = options.maxEvents ?? 50
    this.maxWaitMs = options.maxWaitMs ?? 5_000
    this.maxBuffer = options.maxBuffer ?? 10_000
  }

  /** Returns a promise only when this call triggered a flush. */
  add(event: SpoorEvent): Promise<void> | undefined {
    this.buf.push(event)

    if (this.buf.length > this.maxBuffer) {
      const dropped = this.buf.length - this.maxBuffer
      this.buf.splice(0, dropped)
      this.options.onDrop?.(dropped, 'overflow')
    }

    if (this.buf.length >= this.maxEvents) return this.flush()

    if (this.timer === null) {
      this.timer = setTimeout(() => { void this.flush() }, this.maxWaitMs)
      // Do not hold a Node process open just to flush an empty-ish buffer.
      ;(this.timer as unknown as { unref?: () => void }).unref?.()
    }
    return undefined
  }

  async flush(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
    if (this.buf.length === 0) return
    const batch = this.buf
    this.buf = []
    await this.sink.write(batch)
    await this.sink.flush?.()
  }

  get pending(): number { return this.buf.length }
}
