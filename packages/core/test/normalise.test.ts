import { describe, expect, it } from 'vitest'
import { normalise, normaliseReplayable } from '../src/normalise.js'
import { newEventId, deterministicEventId } from '../src/event-id.js'
import { CORE_FIELDS, isThrottled, isCitationAdjacent } from '../src/schema.js'
import type { NormaliseInput } from '../src/normalise.js'

const req: NormaliseInput = {
  host: 'example.com',
  method: 'GET',
  url: '/products/widget?variant=blue&utm_source=x',
  status: 200,
  userAgent: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  surface: 'test',
  ip: '203.0.113.42',
  referer: 'https://example.com/',
}

describe('normalise', () => {
  it('emits every core field and nothing outside the schema', () => {
    const e = normalise(req)
    for (const f of CORE_FIELDS) expect(e).toHaveProperty(f)
    expect(Object.keys(e).sort()).toEqual([...CORE_FIELDS].sort())
  })

  it('splits the query off the path and drops it by default (PRD §8.1)', () => {
    const e = normalise(req)
    expect(e.path).toBe('/products/widget')
    expect(e.query).toBeNull() // column exists, value does not
  })

  it('retains the query only on explicit opt-in', () => {
    expect(normalise({ ...req, retainQuery: true }).query).toBe('variant=blue&utm_source=x')
  })

  it('truncates the IP and never stores the full address', () => {
    const e = normalise(req)
    expect(e.ip_prefix).toBe('203.0.113.0/24')
    expect(JSON.stringify(e)).not.toContain('203.0.113.42')
  })

  it('classifies and stamps the ruleset version', () => {
    const e = normalise(req)
    expect(e.crawler_bucket).toBe('claudebot')
    expect(e.crawler_purpose).toBe('train')
    expect(e.classifier_version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('accepts a full URL as well as a bare path', () => {
    expect(normalise({ ...req, url: 'https://example.com/a/b?c=1' }).path).toBe('/a/b')
    expect(normalise({ ...req, url: 'https://example.com' }).path).toBe('/')
  })

  it('strips a fragment', () => {
    expect(normalise({ ...req, url: '/a#section' }).path).toBe('/a')
  })

  it('defaults cache_status to unknown rather than guessing hit or miss', () => {
    expect(normalise(req).cache_status).toBe('unknown')
  })

  it('emits a valid ISO timestamp', () => {
    const e = normalise({ ...req, at: 1_767_225_600_000 })
    expect(e.ts).toBe(new Date(1_767_225_600_000).toISOString())
  })
})

describe('event identity (PRD PI-6)', () => {
  it('mints a well-formed, version-7, time-ordered UUID', () => {
    const id = newEventId(1_767_225_600_000)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const earlier = newEventId(1_000_000_000_000)
    const later = newEventId(2_000_000_000_000)
    expect(earlier < later).toBe(true) // lexicographic order tracks time
  })

  it('gives distinct ids to distinct requests', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newEventId()))
    expect(ids.size).toBe(500)
  })

  it('gives a replayed log line the same id, so a re-shipped batch dedupes', () => {
    // A random id would mint a fresh identity for an event already stored and
    // inflate the crawl count — the number being reported.
    const parts = { ts: '2026-09-04T00:00:00.000Z', ip_prefix: '203.0.113.0/24', path: '/p', user_agent: 'GPTBot', status: 200 }
    return Promise.all([deterministicEventId(parts), deterministicEventId(parts)]).then(([a, b]) => {
      expect(a).toBe(b)
      expect(a).toMatch(/^[0-9a-f]{32}$/)
    })
  })

  it('gives different events different deterministic ids', async () => {
    const base = { ts: '2026-09-04T00:00:00.000Z', ip_prefix: null, path: '/a', user_agent: 'GPTBot', status: 200 }
    const a = await deterministicEventId(base)
    const b = await deterministicEventId({ ...base, path: '/b' })
    const c = await deterministicEventId({ ...base, status: 429 })
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('produces a stable id across two normalise calls on the same line', async () => {
    const a = await normaliseReplayable({ ...req, at: 1_767_225_600_000, surface: 'vector' })
    const b = await normaliseReplayable({ ...req, at: 1_767_225_600_000, surface: 'vector' })
    expect(a.event_id).toBe(b.event_id)
  })
})

describe('the three zeros (PRD WB-1, ON-3, RP-2)', () => {
  it('records a throttled crawl distinctly from a successful one', () => {
    // Shopify Web Bot Auth throttles unsigned agents. A 429 is a platform rate
    // limit, not a content finding, and the two must not become one number.
    const throttled = normalise({ ...req, status: 429 })
    expect(isThrottled(throttled)).toBe(true)
    expect(isThrottled(normalise(req))).toBe(false)
  })

  it('flags a user fetch as citation-adjacent', () => {
    const fetchUa = 'Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)'
    expect(isCitationAdjacent(normalise({ ...req, userAgent: fetchUa }))).toBe(true)
    expect(isCitationAdjacent(normalise(req))).toBe(false)
  })
})
