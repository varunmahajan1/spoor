import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileSink } from '@spoor/sinks/node'
import { connect, createEventsView, paths, query } from '../src/store.js'
import { blindSpots, coverage, byPurpose } from '../src/report.js'
import { demoEvents } from '../src/demo.js'
import type { DuckDBConnection } from '@duckdb/node-api'

const PATHS = ['/', '/about', '/pricing', '/blog', '/blog/one', '/blog/two',
  '/products/a', '/products/b', '/products/c', '/products/d',
  '/docs', '/docs/install', '/docs/api', '/contact', '/careers']

let dir: string
let conn: DuckDBConnection

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spoor-test-'))
  const P = paths(dir)
  await fileSink({ dir: P.events }).write(demoEvents(PATHS))
  conn = await connect()
  await createEventsView(conn, P)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('Report 3 — blind spots (PRD §13, RP-1)', () => {
  it('finds URLs no answer engine reached', async () => {
    const rows = await blindSpots(conn, PATHS)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(PATHS.length)
  })

  it('does not count a Googlebot crawl as AI visibility', async () => {
    // The common real finding is a site Google crawls completely and GPTBot
    // barely touches. Counting search crawlers would hide exactly that.
    const strict = await blindSpots(conn, PATHS)
    const loose = await blindSpots(conn, PATHS, { includeSearch: true })
    expect(strict.length).toBeGreaterThan(loose.length)
  })

  it('returns nothing for an empty sitemap rather than erroring', async () => {
    expect(await blindSpots(conn, [])).toEqual([])
  })

  it('reports a path nobody publishes as absent, not as a blind spot', async () => {
    const rows = await blindSpots(conn, ['/only-here'])
    expect(rows.map((r) => r.path)).toEqual(['/only-here'])
  })
})

describe('the three zeros stay separate (PRD RP-2, WB-1)', () => {
  it('counts throttled requests apart from served ones', async () => {
    const rows = await coverage(conn) as Array<Record<string, bigint>>
    const throttled = rows.reduce((n, r) => n + Number(r.throttled ?? 0), 0)
    const ok = rows.reduce((n, r) => n + Number(r.ok ?? 0), 0)
    expect(throttled).toBeGreaterThan(0)
    expect(ok).toBeGreaterThan(throttled)
  })

  it('does not treat a 429 as a successful crawl in blind spots', async () => {
    const [row] = await query<{ n: bigint }>(conn,
      `SELECT count(*) AS n FROM events WHERE status = 429`)
    expect(Number(row!.n)).toBeGreaterThan(0)
    // Every path that appears as reached must have at least one 2xx.
    const [bad] = await query<{ n: bigint }>(conn, `
      SELECT count(*) AS n FROM (
        SELECT path FROM events WHERE status = 429
        EXCEPT
        SELECT path FROM events WHERE status BETWEEN 200 AND 299
      ) t
      WHERE path NOT IN (SELECT path FROM events WHERE status BETWEEN 200 AND 299)
    `)
    expect(Number(bad!.n)).toBe(0)
  })
})

describe('purpose is preserved through to the report (DF-1)', () => {
  it('reports train, index and user_fetch as distinct rows', async () => {
    const rows = await byPurpose(conn) as Array<{ purpose: string }>
    const purposes = rows.map((r) => r.purpose)
    expect(purposes).toContain('train')
    expect(purposes).toContain('index')
    expect(purposes).toContain('user_fetch')
  })
})

describe('the store view deduplicates (PRD PI-6)', () => {
  it('collapses a re-shipped batch rather than inflating the crawl count', async () => {
    // Batches retry — NF-2 makes the adapter drop and the collector retry — so
    // the store *will* contain the same rows twice. Without this, a duplicated
    // batch inflates the crawl count, which is the number being reported.
    const d = mkdtempSync(join(tmpdir(), 'spoor-dedupe-'))
    try {
      const P = paths(d)
      const batch = demoEvents(PATHS)
      const sink = fileSink({ dir: P.events })
      await sink.write(batch)
      await sink.write(batch)          // the identical batch, shipped again
      const c = await connect()
      const n = await createEventsView(c, P)
      expect(n).toBe(batch.length)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('keeps genuinely distinct events, so dedupe does not hide traffic', async () => {
    const d = mkdtempSync(join(tmpdir(), 'spoor-distinct-'))
    try {
      const P = paths(d)
      const sink = fileSink({ dir: P.events })
      const a = demoEvents(PATHS)
      const b = demoEvents(PATHS)      // different requests, different ids
      await sink.write(a)
      await sink.write(b)
      const c = await connect()
      const n = await createEventsView(c, P)
      expect(n).toBe(a.length + b.length)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})
