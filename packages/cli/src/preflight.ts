/**
 * `spoor preflight <url>` — PRD ON-1 to ON-5.
 *
 * Answers, before anyone instruments anything: *can an AI crawler reach this
 * site at all, and is there anything for it to read when it does?*
 *
 * ON-5 exists because moving DNS to Cloudflare in order to install spoor can
 * itself stop the traffic being measured — Cloudflare's "manage AI bot traffic"
 * feature writes the AI block by default, and a site can be invisible to
 * ChatGPT with nobody having chosen it. Discovering that from a flat report six
 * weeks later, having caused it, is the failure that discredits the tool.
 *
 * Nothing here needs the site to be instrumented, and nothing is stored.
 */

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const CRAWLERS: readonly { bucket: string; ua: string }[] = [
  { bucket: 'gptbot', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot' },
  { bucket: 'oai-searchbot', ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot' },
  { bucket: 'claudebot', ua: 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)' },
  { bucket: 'perplexitybot', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) PerplexityBot/1.0; +https://perplexity.ai/perplexitybot' },
  { bucket: 'googlebot', ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
]

export type Verdict = 'ok' | 'warn' | 'fail' | 'info'

export interface Check {
  name: string
  verdict: Verdict
  detail: string
}

export interface PreflightResult {
  url: string
  checks: Check[]
  problems: number
}

async function get(url: string, ua: string): Promise<Response | null> {
  try {
    return await fetch(url, {
      headers: { 'user-agent': ua },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    return null
  }
}

/** Visible text a non-JavaScript client would receive. */
function visibleText(html: string): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)
  const inner = body ? body[1]! : html
  return inner
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Agents a robots.txt disallows outright at the site root. */
function blockedAgents(robots: string): string[] {
  const blocked: string[] = []
  let current: string[] = []
  for (const raw of robots.split('\n')) {
    const line = raw.split('#')[0]!.trim()
    if (!line) { current = []; continue }
    const [field, ...rest] = line.split(':')
    const key = (field ?? '').trim().toLowerCase()
    const value = rest.join(':').trim()
    if (key === 'user-agent') current.push(value.toLowerCase())
    else if (key === 'disallow' && value === '/') blocked.push(...current)
  }
  return [...new Set(blocked)]
}

export async function preflight(input: string): Promise<PreflightResult> {
  const url = input.startsWith('http') ? input : `https://${input}`
  const origin = new URL(url).origin
  const checks: Check[] = []

  // ---- Reachability, as a browser. Everything else is relative to this. ----
  const browser = await get(url, BROWSER_UA)
  if (!browser) {
    checks.push({ name: 'reachable', verdict: 'fail', detail: `no response from ${url}` })
    return { url, checks, problems: 1 }
  }
  checks.push({
    name: 'reachable',
    verdict: browser.ok ? 'ok' : 'warn',
    detail: `${browser.status} as a browser`,
  })

  // ---- ON-1/ON-3: is an AI crawler served the same thing a browser is? ----
  for (const { bucket, ua } of CRAWLERS) {
    const res = await get(url, ua)
    if (!res) {
      checks.push({ name: bucket, verdict: 'fail', detail: 'no response' })
      continue
    }
    if (res.status === 403 || res.status === 401) {
      checks.push({
        name: bucket,
        verdict: 'fail',
        detail: `${res.status} — blocked at the edge while a browser gets ${browser.status}`,
      })
    } else if (res.status === 429) {
      // The third kind of zero (PRD WB-1). Shopify rate-limits unsigned agents.
      checks.push({ name: bucket, verdict: 'warn', detail: '429 — throttled, not blocked and not absent' })
    } else {
      checks.push({ name: bucket, verdict: 'ok', detail: String(res.status) })
    }
  }

  // ---- ON-2: what robots.txt actually says, as served ----
  const robotsRes = await get(`${origin}/robots.txt`, BROWSER_UA)
  if (!robotsRes || !robotsRes.ok) {
    checks.push({ name: 'robots.txt', verdict: 'warn', detail: 'not served' })
  } else {
    const blocked = blockedAgents(await robotsRes.text())
    const aiBlocked = blocked.filter((a) =>
      /gpt|oai|chatgpt|claude|perplexity|bytespider|ccbot|anthropic|google-extended|applebot-extended|\*/.test(a))
    checks.push(aiBlocked.length === 0
      ? { name: 'robots.txt', verdict: 'ok', detail: 'no AI crawler disallowed' }
      : { name: 'robots.txt', verdict: 'fail', detail: `disallows: ${aiBlocked.join(', ')}` })
  }

  // ---- Is there anything to read once they arrive? ----
  const html = await browser.text()
  const text = visibleText(html)
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? ''
  if (text.length < 200) {
    checks.push({
      name: 'body content',
      verdict: 'fail',
      detail: `${text.length} chars of text${title ? `, but <title> is set` : ''} — client-rendered, so crawlers get an empty page`,
    })
  } else {
    checks.push({ name: 'body content', verdict: 'ok', detail: `${text.length} chars served without JavaScript` })
  }

  // ---- Discovery surfaces. Not blockers, but they shape what gets crawled. ----
  const sitemap = await get(`${origin}/sitemap.xml`, BROWSER_UA)
  if (sitemap?.ok) {
    const count = (await sitemap.text()).match(/<loc>/g)?.length ?? 0
    checks.push({ name: 'sitemap.xml', verdict: 'ok', detail: `${count} URLs — use this for blind-spots` })
  } else {
    checks.push({ name: 'sitemap.xml', verdict: 'warn', detail: 'not served; blind-spots needs a URL list' })
  }

  const llms = await get(`${origin}/llms.txt`, BROWSER_UA)
  checks.push(llms?.ok
    ? { name: 'llms.txt', verdict: 'ok', detail: 'present' }
    : { name: 'llms.txt', verdict: 'info', detail: 'absent (optional)' })

  return { url, checks, problems: checks.filter((c) => c.verdict === 'fail').length }
}
