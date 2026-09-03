import { describe, expect, it } from 'vitest'
import { classify, BUCKETS, NOT_USER_AGENTS } from '../src/classifier.js'

/** Real-world user agents, as published by each vendor. */
const UA = {
  gptbot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
  oaiSearch: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
  chatgptUser: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  claudeBot: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  claudeSearch: 'Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +https://www.anthropic.com/claude-searchbot)',
  claudeUser: 'Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)',
  perplexityBot: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) PerplexityBot/1.0; +https://perplexity.ai/perplexitybot',
  perplexityUser: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Perplexity-User/1.0; +https://perplexity.ai/perplexity-user',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  bingbot: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  human: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  humanSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
}

describe('classifier — intent, not vendor (PRD DF-1, §8.3)', () => {
  it('separates the three OpenAI agents into distinct buckets and purposes', () => {
    expect(classify(UA.gptbot)).toMatchObject({ bucket: 'gptbot', purpose: 'train' })
    expect(classify(UA.oaiSearch)).toMatchObject({ bucket: 'oai-searchbot', purpose: 'index' })
    expect(classify(UA.chatgptUser)).toMatchObject({ bucket: 'chatgpt-user', purpose: 'user_fetch' })
  })

  it('separates the three Anthropic agents', () => {
    expect(classify(UA.claudeBot)).toMatchObject({ bucket: 'claudebot', purpose: 'train' })
    expect(classify(UA.claudeSearch)).toMatchObject({ bucket: 'claude-searchbot', purpose: 'index' })
    expect(classify(UA.claudeUser)).toMatchObject({ bucket: 'claude-user', purpose: 'user_fetch' })
  })

  it('separates the two Perplexity agents', () => {
    expect(classify(UA.perplexityBot)).toMatchObject({ bucket: 'perplexitybot', purpose: 'index' })
    expect(classify(UA.perplexityUser)).toMatchObject({ bucket: 'perplexity-user', purpose: 'user_fetch' })
  })

  it('never collapses a training crawler and a user fetch into one bucket', () => {
    // This is the error every incumbent bot list makes, and the one that
    // destroys crawl-to-citation lag (PRD §8.3).
    const pairs = [
      [UA.gptbot, UA.chatgptUser],
      [UA.claudeBot, UA.claudeUser],
      [UA.perplexityBot, UA.perplexityUser],
    ] as const
    for (const [train, fetchUa] of pairs) {
      const a = classify(train)
      const b = classify(fetchUa)
      expect(a.bucket).not.toBe(b.bucket)
      expect(a.purpose).not.toBe(b.purpose)
      expect(b.purpose).toBe('user_fetch')
    }
  })
})

describe('classifier — robots.txt tokens are not user agents (PRD §8.3)', () => {
  it('does not carry google-extended or applebot-extended as buckets', () => {
    for (const token of NOT_USER_AGENTS) {
      expect(BUCKETS).not.toContain(token)
    }
  })

  it('classifies a Google-Extended string as something other than a dedicated bucket', () => {
    // No request ever arrives carrying this. If one somehow did, it must not
    // mint a permanently-zero bucket.
    const c = classify('Mozilla/5.0 (compatible; Google-Extended)')
    expect(BUCKETS).toContain(c.bucket)
    expect(c.bucket).not.toBe('google-extended')
  })
})

describe('classifier — humans and unknowns', () => {
  it('treats ordinary browsers as human', () => {
    expect(classify(UA.human).bucket).toBe('human')
    expect(classify(UA.humanSafari).bucket).toBe('human')
  })

  it('treats a missing or empty user agent as human, not as a bot', () => {
    expect(classify(null).bucket).toBe('human')
    expect(classify(undefined).bucket).toBe('human')
    expect(classify('').bucket).toBe('human')
  })

  it('marks an unrecognised bot-shaped agent other-bot with purpose unknown (CL-4)', () => {
    const c = classify('Mozilla/5.0 (compatible; SomeBrandNewBot/1.0; +http://example.com/bot)')
    expect(c.bucket).toBe('other-bot')
    expect(c.purpose).toBe('unknown') // never guessed from the vendor
  })

  it('recognises command-line clients as bots rather than humans', () => {
    expect(classify('curl/8.7.1').bucket).toBe('other-bot')
    expect(classify('python-requests/2.32.3').bucket).toBe('other-bot')
  })

  it('is case-insensitive', () => {
    expect(classify(UA.gptbot.toUpperCase()).bucket).toBe('gptbot')
    expect(classify(UA.gptbot.toLowerCase()).bucket).toBe('gptbot')
  })

  it('stamps every classification with the ruleset version (CL-2)', () => {
    expect(classify(UA.googlebot).version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(classify(UA.bingbot).version).toBe(classify(UA.human).version)
  })

  it('only ever emits a bucket the frozen schema allows', () => {
    for (const ua of Object.values(UA)) {
      expect(BUCKETS).toContain(classify(ua).bucket)
    }
  })
})
