import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { verify, hasRangesFor, rangesArePopulated } from '../src/verify.js'
import { classify } from '../src/classifier.js'
import type { CrawlerBucket } from '../src/schema.js'

const ranges = JSON.parse(readFileSync(new URL('../data/ranges.json', import.meta.url), 'utf8'))

/** Picks a real address out of a real published range, so the test exercises
 *  the bundled data rather than a fixture that can drift away from it. */
function anAddressIn(bucket: string): string | null {
  const cidrs: string[] = ranges.ranges?.[bucket] ?? []
  const v4 = cidrs.find((c) => c.includes('.') && c.endsWith('/32'))
  return v4 ? v4.slice(0, -3) : null
}

describe('verification against bundled published ranges (PRD VF-2, VF-6)', () => {
  it('has fetched real range data', () => {
    // A failure here means `npm run ranges:update` has not run. VF-5: an empty
    // list produces false `unverified`, which reads as spoofing.
    expect(rangesArePopulated()).toBe(true)
  })

  it('verifies a crawler whose address is inside its operator range', () => {
    for (const bucket of ['gptbot', 'claudebot', 'perplexitybot', 'googlebot'] as CrawlerBucket[]) {
      const ip = anAddressIn(bucket)
      if (!ip) continue
      expect(verify({ bucket, ip })).toEqual({ verified: true, by: 'ip_range' })
    }
  })

  it('refuses a spoofed user agent from an unrelated address', () => {
    // The whole point of OWN-2: a claimed identity is not a trusted one.
    const c = classify('Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)')
    expect(c.bucket).toBe('gptbot')
    expect(verify({ bucket: c.bucket, ip: '203.0.113.7' })).toEqual({
      verified: false, by: 'unverified',
    })
  })

  it('reports unverified — never a guess — when no address is available', () => {
    expect(verify({ bucket: 'gptbot', ip: null })).toEqual({ verified: false, by: 'unverified' })
  })

  it('never claims a human row is verified', () => {
    expect(verify({ bucket: 'human', ip: '8.8.8.8' })).toEqual({ verified: false, by: 'unverified' })
  })

  it('reports unverified for a bucket with no published list', () => {
    expect(hasRangesFor('bytespider')).toBe(false)
    expect(verify({ bucket: 'bytespider', ip: '8.8.8.8' })).toEqual({
      verified: false, by: 'unverified',
    })
  })
})

describe('VF-7 — the Cloudflare signal is opportunistic, never assumed', () => {
  it('uses cf verifiedBot when present and records how (PRD §8.1 verified_by)', () => {
    expect(verify({ bucket: 'googlebot', ip: null, cfVerifiedBot: true })).toEqual({
      verified: true, by: 'cf_verified_bot',
    })
  })

  it('falls back to range matching when the signal is absent', () => {
    // VF-1 was withdrawn: request.cf.botManagement is an Enterprise field, so
    // the common case is that this is undefined.
    const ip = anAddressIn('googlebot')
    if (!ip) return
    expect(verify({ bucket: 'googlebot', ip, cfVerifiedBot: undefined }).by).toBe('ip_range')
  })

  it('does not treat cfVerifiedBot false as a negative verdict on its own', () => {
    const ip = anAddressIn('gptbot')
    if (!ip) return
    expect(verify({ bucket: 'gptbot', ip, cfVerifiedBot: false }).verified).toBe(true)
  })

  it('distinguishes the two verification methods so rows stay comparable', () => {
    const ip = anAddressIn('bingbot')
    if (!ip) return
    const byRange = verify({ bucket: 'bingbot', ip })
    const byCf = verify({ bucket: 'bingbot', ip, cfVerifiedBot: true })
    expect(byRange.by).not.toBe(byCf.by)
  })
})
