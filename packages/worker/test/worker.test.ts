import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorker } from '../src/index.js'
import { memorySink } from '@spoor/sinks'
import type { CfRequest, ExecutionContextLike } from '../src/types.js'

const GPTBOT = 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)'

function ctx() {
  const waited: Promise<unknown>[] = []
  const calls: string[] = []
  const c: ExecutionContextLike & { waited: Promise<unknown>[]; calls: string[] } = {
    waited, calls,
    waitUntil: (p) => { calls.push('waitUntil'); waited.push(p) },
    passThroughOnException: () => { calls.push('passThroughOnException') },
  }
  return c
}

function req(path: string, headers: Record<string, string> = {}, cf?: unknown): CfRequest {
  const r = new Request(`https://shop.example${path}`, {
    headers: { 'user-agent': GPTBOT, host: 'shop.example', 'cf-connecting-ip': '203.0.113.9', ...headers },
  }) as CfRequest
  if (cf) Object.defineProperty(r, 'cf', { value: cf })
  return r
}

/** Stubs the origin. Returns the response the Worker must hand back untouched. */
function originReturns(body: string, init: ResponseInit = {}) {
  const response = new Response(body, init)
  vi.stubGlobal('fetch', vi.fn(async () => response))
  return response
}

afterEach(() => vi.unstubAllGlobals())

describe('NF-2 — the visitor never sees the logger', () => {
  it('calls passThroughOnException before anything else', async () => {
    // Without this a Worker that throws returns a Cloudflare 1101 error page
    // instead of the origin response — the failure mode this whole adapter is
    // shaped around.
    originReturns('ok')
    const c = ctx()
    const w = createWorker(() => ({ sink: memorySink() }))
    await w.fetch(req('/'), {}, c)
    expect(c.calls[0]).toBe('passThroughOnException')
  })

  it('returns the origin response even when configuration throws', async () => {
    originReturns('origin body', { status: 200 })
    const errors: unknown[] = []
    const w = createWorker(() => { throw new Error('bad binding') })
    const res = await w.fetch(req('/'), {}, ctx())
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('origin body')
    expect(errors).toEqual([])   // it did not throw at us
  })

  it('returns the origin response even when the sink throws', async () => {
    originReturns('origin body')
    const onError = vi.fn()
    const w = createWorker(() => ({
      sink: { name: 'broken', async write() { throw new Error('r2 down') } },
      batch: { maxEvents: 1 },
      onError,
    }))
    const c = ctx()
    const res = await w.fetch(req('/'), {}, c)
    expect(await res.text()).toBe('origin body')
    await Promise.all(c.waited)
    expect(onError).toHaveBeenCalled()   // NF-7: loud, not silent
  })

  it('hands the origin response back byte-identical', async () => {
    const origin = originReturns('<html>hello</html>', {
      status: 201, headers: { 'x-origin': 'yes', 'content-type': 'text/html' },
    })
    const w = createWorker(() => ({ sink: memorySink() }))
    const res = await w.fetch(req('/'), {}, ctx())
    expect(res).toBe(origin)             // same object, not a copy
    expect(res.headers.get('x-origin')).toBe('yes')
  })
})

describe('this surface sees the response, so these fields are real', () => {
  it('records the actual status, bytes and duration', async () => {
    originReturns('body', { status: 404, headers: { 'content-length': '4' } })
    const sink = memorySink()
    const c = ctx()
    const w = createWorker(() => ({ sink, batch: { maxEvents: 1 } }))
    await w.fetch(req('/missing'), {}, c)
    await Promise.all(c.waited)

    const e = sink.events[0]!
    expect(e.status).toBe(404)
    expect(e.bytes).toBe(4)
    expect(e.duration_ms).not.toBeNull()
    expect(e.surface).toBe('cloudflare-worker')
  })

  it('translates cf-cache-status instead of recording unknown', async () => {
    // On host middleware this is always `unknown`, because the response does
    // not exist yet at record time. Here it does.
    const cases: [string, string][] = [
      ['HIT', 'hit'], ['MISS', 'miss'], ['EXPIRED', 'miss'],
      ['BYPASS', 'bypass'], ['DYNAMIC', 'bypass'], ['REVALIDATED', 'revalidated'],
    ]
    for (const [header, expected] of cases) {
      originReturns('x', { headers: { 'cf-cache-status': header } })
      const sink = memorySink()
      const c = ctx()
      const w = createWorker(() => ({ sink, batch: { maxEvents: 1 } }))
      await w.fetch(req('/'), {}, c)
      await Promise.all(c.waited)
      expect(sink.events[0]!.cache_status).toBe(expected)
    }
  })

  it('records unknown when the header is absent, rather than guessing', async () => {
    originReturns('x')
    const sink = memorySink()
    const c = ctx()
    const w = createWorker(() => ({ sink, batch: { maxEvents: 1 } }))
    await w.fetch(req('/'), {}, c)
    await Promise.all(c.waited)
    expect(sink.events[0]!.cache_status).toBe('unknown')
  })

  it('records null bytes rather than 0 when content-length is absent', async () => {
    originReturns('x')
    const sink = memorySink()
    const c = ctx()
    const w = createWorker(() => ({ sink, batch: { maxEvents: 1 } }))
    await w.fetch(req('/'), {}, c)
    await Promise.all(c.waited)
    expect(sink.events[0]!.bytes).toBeNull()
  })
})

describe('SH-7 — checkout is never touched', () => {
  it('proxies checkout without recording it', async () => {
    // PCI scope is not ours to reason about, and a crawler has never requested
    // a checkout page, so nothing is measured by going near it.
    for (const path of ['/checkout', '/checkout/step-2', '/checkouts/abc123']) {
      originReturns('checkout')
      const sink = memorySink()
      const c = ctx()
      const w = createWorker(() => ({ sink, batch: { maxEvents: 1 } }))
      const res = await w.fetch(req(path), {}, c)
      await Promise.all(c.waited)
      expect(await res.text()).toBe('checkout')
      expect(sink.events).toHaveLength(0)
    }
  })

  it('still records a path that merely contains the word', async () => {
    originReturns('page')
    const sink = memorySink()
    const c = ctx()
    const w = createWorker(() => ({ sink, batch: { maxEvents: 1 } }))
    await w.fetch(req('/blog/checkout-tips'), {}, c)
    await Promise.all(c.waited)
    expect(sink.events).toHaveLength(1)
  })
})

describe('VF-7 — the Cloudflare bot signal is opportunistic', () => {
  it('uses verifiedBot when the zone provides it', async () => {
    originReturns('x')
    const sink = memorySink()
    const c = ctx()
    const w = createWorker(() => ({ sink, batch: { maxEvents: 1 } }))
    await w.fetch(req('/', {}, { botManagement: { verifiedBot: true } }), {}, c)
    await Promise.all(c.waited)
    expect(sink.events[0]!.verified_by).toBe('cf_verified_bot')
  })

  it('falls back to range verification when absent — the common case', async () => {
    // request.cf.botManagement is Enterprise-only, so most zones never populate
    // it. That is why VF-1 was withdrawn and every surface bundles the ranges.
    originReturns('x')
    const sink = memorySink()
    const c = ctx()
    const w = createWorker(() => ({ sink, batch: { maxEvents: 1 } }))
    await w.fetch(req('/'), {}, c)
    await Promise.all(c.waited)
    expect(sink.events[0]!.verified_by).not.toBe('cf_verified_bot')
  })
})

describe('recording behaviour', () => {
  it('drops human rows and keeps crawler rows', async () => {
    originReturns('x')
    const sink = memorySink()
    const c = ctx()
    const w = createWorker(() => ({ sink, batch: { maxEvents: 1 } }))
    await w.fetch(req('/', { 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/131.0.0.0 Safari/537.36' }), {}, c)
    await Promise.all(c.waited)
    expect(sink.events).toHaveLength(0)
  })

  it('reuses one recorder across requests, which is what makes batching work', async () => {
    originReturns('x')
    const sink = memorySink()
    const c = ctx()
    const w = createWorker(() => ({ sink, batch: { maxEvents: 3, maxWaitMs: 60_000 } }))
    await w.fetch(req('/a'), {}, c)
    await w.fetch(req('/b'), {}, c)
    expect(sink.events).toHaveLength(0)          // buffered, not written per request
    await w.fetch(req('/c'), {}, c)
    await Promise.all(c.waited)
    expect(sink.events).toHaveLength(3)          // one write, three events
  })
})
