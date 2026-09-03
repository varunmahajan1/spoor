#!/usr/bin/env node
/**
 * Regenerates wordpress/test/golden.json from the TypeScript implementation.
 *
 * The WordPress adapter is PHP and cannot import core, so the only way to know
 * the two agree is to pin TypeScript's answers and assert PHP reproduces them.
 * Run this after changing the ruleset, then run scripts/test-php.sh.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { classify } from '../packages/core/dist/classifier.js'
import { deterministicEventId } from '../packages/core/dist/event-id.js'
import { truncateIp } from '../packages/core/dist/ip.js'

const here = dirname(fileURLToPath(import.meta.url))

const UAS = [
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  'Mozilla/5.0 (compatible; Claude-SearchBot/1.0)',
  'Mozilla/5.0 (compatible; Claude-User/1.0)',
  'Mozilla/5.0 (Macintosh) PerplexityBot/1.0; +https://perplexity.ai/perplexitybot',
  'Mozilla/5.0 (Macintosh) Perplexity-User/1.0',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  'Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)',
  'Mozilla/5.0 (compatible; Amazonbot/0.1)',
  'meta-externalagent/1.1',
  'Mozilla/5.0 (compatible; SomeBrandNewBot/1.0; +http://example.com/bot)',
  'curl/8.7.1',
  'python-requests/2.32.3',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1',
  '',
]
const IPS = ['203.0.113.42', '8.8.8.8', '255.255.255.255', '2001:db8:1234:5678::1', '2001:db8::1', 'not-an-ip', '']
const IDS = [
  ['2026-09-04T10:00:00.000Z', '203.0.113.0/24', '/products/widget', 'GPTBot', 200],
  ['2026-09-04T10:00:00.000Z', null, '/', 'curl/8.7.1', 404],
  ['2026-01-01T00:00:00.000Z', '2001:db8:1234::/48', '/a/b', 'x', 429],
]

const golden = { classify: {}, truncate: {}, eventId: {} }
for (const ua of UAS) {
  const c = classify(ua)
  golden.classify[ua] = { bucket: c.bucket, purpose: c.purpose }
}
for (const ip of IPS) golden.truncate[ip] = truncateIp(ip)
for (const [ts, ip_prefix, path, user_agent, status] of IDS) {
  golden.eventId[JSON.stringify([ts, ip_prefix, path, user_agent, status])] =
    await deterministicEventId({ ts, ip_prefix, path, user_agent, status })
}

writeFileSync(join(here, '..', 'wordpress', 'test', 'golden.json'), JSON.stringify(golden, null, 2) + '\n')
console.log(`golden.json — ${UAS.length} agents, ${IPS.length} addresses, ${IDS.length} ids`)
