import type { SpoorEvent } from '@spoor/core'

/**
 * A destination for events — PRD SN-1, AR-2.
 *
 * Sinks are plugins behind one interface and no source knows about any sink.
 * `write` receives a batch, never a single event, because NF-3 forbids a
 * per-request round trip.
 *
 * A sink must not throw into its caller. Adapters run on a request path where
 * NF-2 applies, so a sink that is down has to degrade to a dropped batch, never
 * to a failed response. `SafeSink` enforces this rather than trusting each
 * implementation to remember.
 */
export interface Sink {
  readonly name: string
  write(events: readonly SpoorEvent[]): Promise<void>
  flush?(): Promise<void>
  close?(): Promise<void>
}

export interface SafeSinkOptions {
  /** Called with anything the sink threw. NF-7: a silently failing fail-open
   *  surface produces a clean-looking dataset with holes in it. */
  onError?: (error: unknown, dropped: number) => void
}

/** Wraps a sink so no failure can reach the request path. */
export function safeSink(inner: Sink, options: SafeSinkOptions = {}): Sink {
  const report = (error: unknown, dropped: number) => {
    try {
      options.onError?.(error, dropped)
    } catch {
      /* an error reporter that throws must not become the outage */
    }
  }
  return {
    name: inner.name,
    async write(events) {
      try {
        await inner.write(events)
      } catch (error) {
        report(error, events.length)
      }
    },
    async flush() {
      try {
        await inner.flush?.()
      } catch (error) {
        report(error, 0)
      }
    },
    async close() {
      try {
        await inner.close?.()
      } catch (error) {
        report(error, 0)
      }
    },
  }
}

/** Fans out to several sinks; one failing does not stop the others. */
export function multiSink(...sinks: Sink[]): Sink {
  return {
    name: `multi(${sinks.map((s) => s.name).join(', ')})`,
    async write(events) { await Promise.all(sinks.map((s) => s.write(events))) },
    async flush() { await Promise.all(sinks.map((s) => s.flush?.())) },
    async close() { await Promise.all(sinks.map((s) => s.close?.())) },
  }
}
