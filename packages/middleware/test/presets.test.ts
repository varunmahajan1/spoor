import { describe, expect, it } from 'vitest'
import { preset, PRESET_NAMES } from '../src/presets.js'
import { createRecorder } from '../src/index.js'
import { memorySink } from '@spoor/sinks'

/** Approximates how a host evaluates `config.matcher` against a path. */
const matches = (matcher: string, path: string) => new RegExp(`^${matcher}$`).test(path)

const CORPUS = [
  '/', '/about', '/pricing', '/blog', '/blog/post-one', '/docs/api',
  '/products/widget', '/contact', '/careers', '/llms.txt', '/robots.txt',
  '/sitemap.xml', '/og-image.png', '/brochures/deck.pdf',
  '/assets/index-DuFxIVXK.js', '/assets/index-tOjP4MCY.css',
  '/_next/static/chunks/main.js', '/_next/image?url=x', '/_astro/hoisted.js',
  '/favicon.ico', '/favicon.png', '/apple-touch-icon.png',
]

describe('presets know each framework’s build output', () => {
  it('vite ignores hashed bundles under /assets/', () => {
    const p = preset('vite')
    expect(p.ignore('/assets/index-DuFxIVXK.js')).toBe(true)
    expect(p.ignore('/assets/index-tOjP4MCY.css')).toBe(true)
    expect(p.ignore('/about')).toBe(false)
  })

  it('next ignores its own build output', () => {
    const p = preset('next')
    expect(p.ignore('/_next/static/chunks/main.js')).toBe(true)
    expect(p.ignore('/_next/image?url=x')).toBe(true)
    expect(p.ignore('/about')).toBe(false)
  })

  it('astro ignores /_astro/', () => {
    expect(preset('astro').ignore('/_astro/hoisted.js')).toBe(true)
  })

  it('the next preset does NOT cover Vite output — the bug this exists to stop', () => {
    // A Vite site instrumented with the Next list records every bundle as a
    // page fetch, and blind-spots then reads as coverage of URLs no crawler
    // ever asked for.
    expect(preset('next').ignore('/assets/index-DuFxIVXK.js')).toBe(false)
    expect(preset('vite').ignore('/assets/index-DuFxIVXK.js')).toBe(true)
  })

  it('ignores icons on every preset', () => {
    for (const name of PRESET_NAMES) {
      const p = preset(name)
      expect(p.ignore('/favicon.ico')).toBe(true)
      expect(p.ignore('/apple-touch-icon.png')).toBe(true)
    }
  })

  it('never ignores robots.txt, sitemap.xml or llms.txt', () => {
    // A crawler fetching one of these is the crawler announcing what it intends
    // to do next — among the most informative rows in the dataset.
    for (const name of PRESET_NAMES) {
      const p = preset(name)
      for (const path of ['/robots.txt', '/sitemap.xml', '/llms.txt']) {
        expect(p.ignore(path)).toBe(false)
      }
    }
  })

  it('the none preset ignores only icons', () => {
    const p = preset('none')
    expect(p.ignore('/assets/x.js')).toBe(false)
    expect(p.ignore('/favicon.ico')).toBe(true)
    expect(p.matcher[0]).toBeTruthy()
  })
})

describe('ignore and matcher cannot drift', () => {
  it('agrees on every path in the corpus, for every preset', () => {
    // Both are generated from one `paths` array, so this is a proof of the
    // generation rather than a reminder to keep two lists in sync.
    for (const name of PRESET_NAMES) {
      const p = preset(name)
      for (const path of CORPUS) {
        const ignored = p.ignore(path)
        const routed = matches(p.matcher[0]!, path)
        expect(
          { preset: name, path, ignored, routed },
        ).toEqual({ preset: name, path, ignored, routed: !ignored })
      }
    }
  })

  it('produces a matcher that still routes real pages', () => {
    const p = preset('vite')
    expect(matches(p.matcher[0]!, '/')).toBe(true)
    expect(matches(p.matcher[0]!, '/about')).toBe(true)
    expect(matches(p.matcher[0]!, '/assets/index-abc.js')).toBe(false)
  })

  it('escapes regex metacharacters in paths', () => {
    // `favicon.ico` unescaped would let `faviconXico` through the matcher while
    // `ignore` still caught it — a silent disagreement.
    const m = preset('none').matcher[0]!
    expect(matches(m, '/faviconXico')).toBe(true)
    expect(matches(m, '/favicon.ico')).toBe(false)
  })
})

describe('a preset spreads straight into the recorder', () => {
  it('supplies both ignore and surface', async () => {
    const sink = memorySink()
    const site = preset('vite', 'vercel-middleware')
    const r = createRecorder({ sink, ...site, batch: { maxEvents: 1 } })

    const req = (url: string) => new Request(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; GPTBot/1.2)', host: 'maticx.co' },
    })

    await r.record(req('https://maticx.co/assets/index-DuFxIVXK.js'))
    expect(sink.events).toHaveLength(0)          // asset ignored

    await r.record(req('https://maticx.co/about'))
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]!.surface).toBe('vercel-middleware')
    expect(sink.events[0]!.path).toBe('/about')
  })

  it('defaults to ignoring every framework’s output when no preset is given', async () => {
    const sink = memorySink()
    const r = createRecorder({ sink, batch: { maxEvents: 1 } })
    const ua = { 'user-agent': 'Mozilla/5.0 (compatible; GPTBot/1.2)', host: 'x.com' }
    for (const p of ['/assets/a.js', '/_next/static/b.js', '/_astro/c.js', '/favicon.ico']) {
      await r.record(new Request(`https://x.com${p}`, { headers: ua }))
    }
    expect(sink.events).toHaveLength(0)
  })

  it('records cache_status as unknown, because middleware runs before the cache', async () => {
    const sink = memorySink()
    const r = createRecorder({ sink, ...preset('vite'), batch: { maxEvents: 1 } })
    await r.record(new Request('https://maticx.co/about', {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; ClaudeBot/1.0)', host: 'maticx.co' },
    }))
    expect(sink.events[0]!.cache_status).toBe('unknown')
  })
})
