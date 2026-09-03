import { describe, expect, it, vi } from 'vitest'
import { createRecorder, record, KillSwitch } from '../src/index.js'
import { memorySink } from '@spoor/sinks'
import type { Sink } from '@spoor/sinks'

const GPTBOT = 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)'
const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'

const req = (ua: string, url = 'https://example.com/products/widget') =>
  new Request(url, { headers: { 'user-agent': ua, host: 'example.com', 'cf-connecting-ip': '203.0.113.9' } })

/** A sink that fails the way a real one does when the endpoint is down. */
const brokenSink = (): Sink => ({
  name: 'broken',
  async write() { throw new Error('collector endpoint unreachable') },
})

/** A sink that fails synchronously, which a rejected promise does not cover. */
const explodingSink = (): Sink => ({
  name: 'exploding',
  write() { throw new Error('boom') },
})

describe('NF-2 / NF-8 — a thrown logger must never change what the visitor receives', () => {
  it('does not throw when the sink rejects', async () => {
    const errors: unknown[] = []
    const r = createRecorder({ sink: brokenSink(), batch: { maxEvents: 1 }, onError: (e) => errors.push(e) })
    await expect(r.record(req(GPTBOT))).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })

  it('does not throw when the sink throws synchronously', async () => {
    const errors: unknown[] = []
    const r = createRecorder({ sink: explodingSink(), batch: { maxEvents: 1 }, onError: (e) => errors.push(e) })
    await expect(r.record(req(GPTBOT))).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })

  it('reports the failure rather than swallowing it (NF-7)', async () => {
    // A silently failing fail-open surface produces a clean-looking dataset
    // with holes in it, which is worse than an outage because nobody notices.
    const onError = vi.fn()
    const r = createRecorder({ sink: brokenSink(), batch: { maxEvents: 1 }, onError })
    await r.record(req(GPTBOT))
    expect(onError).toHaveBeenCalledOnce()
  })

  it('survives a malformed request without throwing', () => {
    const r = createRecorder({ sink: memorySink() })
    const broken = { url: undefined, method: undefined, headers: { get() { throw new Error('header blew up') } } }
    expect(() => r.record(broken as unknown as Request)).not.toThrow()
  })

  it('record() swallows everything, including a recorder that throws', () => {
    const exploding = { record() { throw new Error('nope') }, flush: async () => {} }
    expect(() => record(exploding, req(GPTBOT))).not.toThrow()
  })

  it('hands a triggered flush to waitUntil rather than to the request (NF-1)', () => {
    const waitUntil = vi.fn()
    const r = createRecorder({ sink: memorySink(), batch: { maxEvents: 1 } })
    record(r, req(GPTBOT), waitUntil)
    expect(waitUntil).toHaveBeenCalledOnce()
    expect(waitUntil.mock.calls[0]![0]).toBeInstanceOf(Promise)
  })
})

describe('NF-3 — batching', () => {
  it('does not write per request', async () => {
    const sink = memorySink()
    const r = createRecorder({ sink, batch: { maxEvents: 5, maxWaitMs: 60_000 } })
    for (let i = 0; i < 4; i++) r.record(req(GPTBOT, `https://example.com/p/${i}`))
    expect(sink.events).toHaveLength(0) // still buffered
    await r.record(req(GPTBOT, 'https://example.com/p/4'))
    expect(sink.events).toHaveLength(5) // one write, five events
  })

  it('flushes what is buffered on demand', async () => {
    const sink = memorySink()
    const r = createRecorder({ sink, batch: { maxEvents: 100, maxWaitMs: 60_000 } })
    r.record(req(GPTBOT))
    await r.flush()
    expect(sink.events).toHaveLength(1)
  })
})

describe('NF-4 — the kill switch fails open', () => {
  it('keeps recording when the probe throws', async () => {
    const kill = new KillSwitch({ probe: () => { throw new Error('KV down') }, ttlMs: 0 })
    expect(kill.enabled()).toBe(true)
    await new Promise((r) => setTimeout(r, 5))
    expect(kill.enabled()).toBe(true)
  })

  it('keeps recording when the probe hangs, rather than waiting on it', async () => {
    const kill = new KillSwitch({ probe: () => new Promise<boolean>(() => {}), ttlMs: 0, timeoutMs: 5 })
    const started = Date.now()
    expect(kill.enabled()).toBe(true) // returns immediately, does not await
    expect(Date.now() - started).toBeLessThan(5)
  })

  it('stops recording once the probe reports disabled', async () => {
    const sink = memorySink()
    const r = createRecorder({
      sink,
      batch: { maxEvents: 1 },
      killSwitch: { probe: () => false, ttlMs: 0, timeoutMs: 50 },
    })
    await r.record(req(GPTBOT)) // first call primes the cache
    await new Promise((res) => setTimeout(res, 10))
    const before = sink.events.length
    await r.record(req(GPTBOT))
    expect(sink.events.length).toBe(before)
  })

  it('records normally when no probe is configured', async () => {
    const sink = memorySink()
    const r = createRecorder({ sink, batch: { maxEvents: 1 } })
    await r.record(req(GPTBOT))
    expect(sink.events).toHaveLength(1)
  })
})

describe('what gets recorded', () => {
  it('drops human rows at source by default (LG-3)', async () => {
    const sink = memorySink()
    const r = createRecorder({ sink, batch: { maxEvents: 1 } })
    await r.record(req(HUMAN))
    expect(sink.events).toHaveLength(0)
  })

  it('retains human rows on explicit opt-in', async () => {
    const sink = memorySink()
    const r = createRecorder({ sink, dropHumans: false, batch: { maxEvents: 1 } })
    await r.record(req(HUMAN))
    expect(sink.events).toHaveLength(1)
  })

  it('ignores static asset paths', async () => {
    const sink = memorySink()
    const r = createRecorder({ sink, batch: { maxEvents: 1 } })
    await r.record(req(GPTBOT, 'https://example.com/_next/static/chunk.js'))
    expect(sink.events).toHaveLength(0)
  })

  it('truncates the IP and classifies the agent', async () => {
    const sink = memorySink()
    const r = createRecorder({ sink, batch: { maxEvents: 1 } })
    await r.record(req(GPTBOT))
    const e = sink.events[0]!
    expect(e.crawler_bucket).toBe('gptbot')
    expect(e.crawler_purpose).toBe('train')
    expect(e.ip_prefix).toBe('203.0.113.0/24')
    expect(e.surface).toBe('vercel-middleware')  // default; a preset sets it explicitly
    expect(JSON.stringify(e)).not.toContain('203.0.113.9')
  })

  it('records the status it is given, so a throttle is not a crawl (WB-1)', async () => {
    const sink = memorySink()
    const r = createRecorder({ sink, batch: { maxEvents: 1 } })
    await r.record(req(GPTBOT), { status: 429 })
    expect(sink.events[0]!.status).toBe(429)
  })
})
