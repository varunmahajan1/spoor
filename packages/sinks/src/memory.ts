import type { SpoorEvent } from '@spoor/core'
import type { Sink } from './sink.js'

/** For tests and for `spoor demo`. */
export function memorySink(): Sink & { events: SpoorEvent[] } {
  const events: SpoorEvent[] = []
  return {
    name: 'memory',
    events,
    async write(batch) { events.push(...batch) },
  }
}
