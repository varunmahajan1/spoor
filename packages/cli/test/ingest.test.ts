import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memorySink } from '@spoor/sinks'
import { ingest, rowToEvent } from '../src/ingest.js'
import type { RawLogRow } from '../src/ingest.js'

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'spoor-ingest-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const GPTBOT = 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)'
const row = (over: Partial<RawLogRow> = {}): RawLogRow => ({
  ts: '2026-09-04T10:00:00Z', host: 'shop.example', method: 'GET',
  url: '/products/widget?variant=blue', status: 200, bytes: 5120,
  duration_ms: 34, user_agent: GPTBOT, referer: 'https://shop.example/',
  ip: '203.0.113.42', ...over,
})

describe('rowToEvent — a Vector row becomes a schema row', () => {
  it('classifies and verifies, which Vector deliberately does not', async () => {
    const e = await rowToEvent(row())
    expect(e.crawler_bucket).toBe('gptbot')
    expect(e.crawler_purpose).toBe('train')
    expect(e.surface).toBe('vector')
    expect(e.classifier_version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('truncates the IP and never carries the full address through', async () => {
    // LG-2 — this is why `spoor ingest` runs on the log host.
    const e = await rowToEvent(row())
    expect(e.ip_prefix).toBe('203.0.113.0/24')
    expect(JSON.stringify(e)).not.toContain('203.0.113.42')
  })

  it('drops the query string unless asked', async () => {
    expect((await rowToEvent(row())).path).toBe('/products/widget')
    expect((await rowToEvent(row())).query).toBeNull()
    expect((await rowToEvent(row(), { retainQuery: true })).query).toBe('variant=blue')
  })

  it('gives a replayed line the same id, so a restarted shipper cannot double-count', async () => {
    // The whole reason log-derived surfaces use a content hash rather than a
    // UUID: a restarted Vector re-reads lines with no memory of sending them.
    const a = await rowToEvent(row())
    const b = await rowToEvent(row())
    expect(a.event_id).toBe(b.event_id)
    const c = await rowToEvent(row({ url: '/other' }))
    expect(c.event_id).not.toBe(a.event_id)
  })

  it("records cache_status unknown, because an origin log cannot see the edge", async () => {
    expect((await rowToEvent(row())).cache_status).toBe('unknown')
  })

  it('survives nginx dashes and missing fields without inventing values', async () => {
    const e = await rowToEvent({ user_agent: GPTBOT, url: '/x', status: '200', bytes: '-', duration_ms: null })
    expect(e.bytes).toBeNull()
    expect(e.duration_ms).toBeNull()
    expect(e.status).toBe(200)
  })
})

describe('ingest — reading a spool', () => {
  it('reads NDJSON and drops human rows at source', async () => {
    const d = tmp()
    const human = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
    writeFileSync(join(d, '2026-09-04.ndjson'), [
      JSON.stringify(row()),
      JSON.stringify(row({ user_agent: human })),
      JSON.stringify(row({ url: '/about', user_agent: 'Mozilla/5.0 (compatible; ClaudeBot/1.0)' })),
    ].join('\n') + '\n')

    const sink = memorySink()
    const r = await ingest(d, sink)
    expect(r.read).toBe(3)
    expect(r.skippedHuman).toBe(1)
    expect(sink.events).toHaveLength(2)
    expect(sink.events.map((e) => e.crawler_bucket).sort()).toEqual(['claudebot', 'gptbot'])
  })

  it('skips an unparseable line rather than aborting the spool', async () => {
    const d = tmp()
    writeFileSync(join(d, 'a.ndjson'), `${JSON.stringify(row())}\nnot json at all\n${JSON.stringify(row({ url: '/b' }))}\n`)
    const sink = memorySink()
    const r = await ingest(d, sink)
    expect(r.malformed).toBe(1)
    expect(sink.events).toHaveLength(2)   // the good lines still landed
  })

  it('accepts a single file as well as a directory', async () => {
    const d = tmp()
    const f = join(d, 'one.ndjson')
    writeFileSync(f, JSON.stringify(row()) + '\n')
    const sink = memorySink()
    await ingest(f, sink)
    expect(sink.events).toHaveLength(1)
  })

  it('keeps human rows on explicit opt-in', async () => {
    const d = tmp()
    const human = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
    writeFileSync(join(d, 'a.ndjson'), JSON.stringify(row({ user_agent: human })) + '\n')
    const sink = memorySink()
    await ingest(d, sink, { keepHumans: true })
    expect(sink.events).toHaveLength(1)
  })
})
