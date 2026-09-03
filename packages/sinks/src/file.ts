import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SpoorEvent } from '@spoor/core'
import type { Sink } from './sink.js'

export interface FileSinkOptions {
  /** Defaults to `.spoor/events`. */
  dir?: string
}

/**
 * Append-only NDJSON partitioned by date — PRD SN-2, SN-3.
 *
 * This is the default sink, because the tool has to produce a useful answer for
 * someone who configured nothing (PI-8). Node only: it is never imported by an
 * edge adapter.
 */
export function fileSink(options: FileSinkOptions = {}): Sink {
  const dir = options.dir ?? join('.spoor', 'events')
  let ensured = false

  return {
    name: `file(${dir})`,
    async write(events: readonly SpoorEvent[]) {
      if (events.length === 0) return
      // Partition by the event's own date, not by today's, so a late-arriving
      // batch lands in the partition it belongs to.
      const byDay = new Map<string, string[]>()
      for (const e of events) {
        const day = e.ts.slice(0, 10)
        const lines = byDay.get(day) ?? []
        lines.push(JSON.stringify(e))
        byDay.set(day, lines)
      }
      for (const [day, lines] of byDay) {
        const path = join(dir, `${day}.ndjson`)
        if (!ensured) { await mkdir(dirname(path), { recursive: true }); ensured = true }
        await appendFile(path, lines.join('\n') + '\n', 'utf8')
      }
    },
  }
}
