import { normalise } from '@spoor/core'
import type { SpoorEvent } from '@spoor/core'

/**
 * Synthetic traffic, so someone can see a real finding within seconds of
 * cloning rather than after waiting a week for a crawler to arrive.
 *
 * The shape is the common real one and the demo would be useless without it:
 * Googlebot reaches everything, the answer engines reach a fraction, and the
 * fraction they miss is the finding. A demo that showed full coverage would
 * teach the reader nothing about what the tool is for.
 *
 * Every row carries surface `test`, so demo data can never be mistaken for
 * collected data.
 */
const AGENTS: readonly { ua: string; hits: number; reach: number }[] = [
  { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', hits: 60, reach: 1.0 },
  { ua: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', hits: 24, reach: 0.85 },
  { ua: 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)', hits: 34, reach: 0.45 },
  { ua: 'Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)', hits: 12, reach: 0.35 },
  { ua: 'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)', hits: 8, reach: 0.20 },
  { ua: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', hits: 18, reach: 0.40 },
  { ua: 'Mozilla/5.0 (compatible; Claude-SearchBot/1.0)', hits: 6, reach: 0.25 },
  { ua: 'Mozilla/5.0 (compatible; Claude-User/1.0)', hits: 4, reach: 0.15 },
  { ua: 'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)', hits: 9, reach: 0.30 },
]

export function demoEvents(paths: readonly string[], days = 14): SpoorEvent[] {
  const events: SpoorEvent[] = []
  const now = Date.now()
  let seed = 20260904
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648

  for (const { ua, hits, reach } of AGENTS) {
    // Each agent explores a prefix of the sitemap — deeper pages go unreached,
    // which is what the blind-spots report finds.
    const reachable = Math.max(1, Math.floor(paths.length * reach))
    for (let i = 0; i < hits; i++) {
      const path = paths[Math.floor(rand() * reachable)] ?? paths[0]!
      // A small share of requests are rate-limited by the platform. WB-1: that
      // is a throttle, not a crawl, and the report must not count it as one.
      const throttled = rand() < 0.05
      events.push(normalise({
        host: 'example.com',
        method: 'GET',
        url: path,
        status: throttled ? 429 : 200,
        userAgent: ua,
        surface: 'test',
        ip: `203.0.113.${Math.floor(rand() * 254) + 1}`,
        at: now - Math.floor(rand() * days * 86_400_000),
      }))
    }
  }
  return events.sort((a, b) => a.ts.localeCompare(b.ts))
}
