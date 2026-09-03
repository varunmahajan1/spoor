/**
 * The spoor event schema — PRD §8.1 (core) and §8.2 (extension).
 *
 * Field names are frozen. A core field never moves to the extension, and no
 * core report may require an extension field.
 */

/** PRD §8.1. Specific agent, never vendor — collapsing GPTBot and ChatGPT-User
 *  destroys the crawl-to-citation report (§8.3, DF-1). */
export type CrawlerBucket =
  | 'gptbot' | 'oai-searchbot' | 'chatgpt-user'
  | 'claudebot' | 'claude-searchbot' | 'claude-user'
  | 'perplexitybot' | 'perplexity-user'
  | 'googlebot' | 'google-other' | 'bingbot' | 'applebot'
  | 'bytespider' | 'amazonbot' | 'meta-externalagent'
  | 'other-bot' | 'human'

/** The field the reports group by. `user_fetch` is close to a citation event —
 *  the model retrieving the page to answer somebody, at that moment. */
export type CrawlerPurpose = 'train' | 'index' | 'user_fetch' | 'preview' | 'unknown'

/** How verification was established. Without this, a verified row from one
 *  surface and one from another are not comparable (PRD §8.1, VF-7). */
export type VerifiedBy = 'ip_range' | 'rdns' | 'cf_verified_bot' | 'unverified'

/**
 * Which collection surface produced the row.
 *
 * Every value names a *place code runs*, never a framework — the framework
 * determines what to ignore, the host determines where collection happens and
 * what the row can be compared against. `next-middleware` is a self-hosted Next
 * server; the same code deployed to Vercel is `vercel-middleware`, because it
 * runs at a different point relative to the cache.
 */
export type Surface =
  | 'next-middleware'
  | 'vercel-middleware'
  | 'cloudflare-worker'
  | 'vector'
  | 'vercel-drain'
  | 'wordpress'
  | 'test'

/** Whether the origin was reached. A response served from cache without
 *  invoking the logger is an unlogged visit; recording this makes the blind
 *  spot a per-row fact rather than a suspicion. */
export type CacheStatus = 'hit' | 'miss' | 'bypass' | 'revalidated' | 'unknown'

/** PRD §8.1 — emitted by every surface. */
export interface SpoorEvent {
  /** UUIDv7, or a hash of ts|ip_prefix|path|user_agent|status. The dedupe key:
   *  without it the roll-up cannot deduplicate retried batches (PI-6). */
  event_id: string
  /** ISO 8601, UTC. */
  ts: string
  host: string
  method: string
  /** Path only, no query string. */
  path: string
  /** Null unless the operator opts in. The column exists regardless, so the
   *  first faceted-navigation finding does not force a schema change. */
  query: string | null
  /** Load-bearing for WB-1: a 429 is a platform throttle, not a crawl. */
  status: number
  bytes: number | null
  duration_ms: number | null
  cache_status: CacheStatus
  /** Raw string. The source of truth — every derived field is re-derivable
   *  from it, which is what makes CL-3 reclassification possible. */
  user_agent: string
  crawler_bucket: CrawlerBucket
  crawler_purpose: CrawlerPurpose
  crawler_verified: boolean
  verified_by: VerifiedBy
  /** Which ruleset produced bucket and purpose. Enables re-derivation. */
  classifier_version: string
  referer: string | null
  /** Truncated at source: /24 for IPv4, /48 for IPv6. Preserves published-range
   *  membership so a corrected range list can be re-applied to history (VF-4). */
  ip_prefix: string | null
  surface: Surface
}

/** PRD §8.2 — multi-tenant only. Absent in a single-operator install, where
 *  `host` already distinguishes sites. */
export interface SpoorEventExtension {
  tenant?: string
  ip_hash?: string | null
  salt_epoch?: number | null
}

export type SpoorEventFull = SpoorEvent & SpoorEventExtension

export const CORE_FIELDS = [
  'event_id', 'ts', 'host', 'method', 'path', 'query', 'status', 'bytes',
  'duration_ms', 'cache_status', 'user_agent', 'crawler_bucket',
  'crawler_purpose', 'crawler_verified', 'verified_by', 'classifier_version',
  'referer', 'ip_prefix', 'surface',
] as const satisfies readonly (keyof SpoorEvent)[]

/** A purpose that indicates a live user is waiting on the answer — the signal
 *  Report 2 measures lag to. */
export function isCitationAdjacent(e: Pick<SpoorEvent, 'crawler_purpose'>): boolean {
  return e.crawler_purpose === 'user_fetch'
}

/** PRD WB-1/RP-2: a zero that means "throttled" is not a zero that means
 *  "never crawled". Any report counting crawl volume without this is wrong in
 *  the direction that looks like a content problem. */
export function isThrottled(e: Pick<SpoorEvent, 'status'>): boolean {
  return e.status === 429
}

export function isSuccessfulFetch(e: Pick<SpoorEvent, 'status'>): boolean {
  return e.status >= 200 && e.status < 300
}

/**
 * Answer-engine crawlers — the agents whose absence means an AI assistant
 * cannot see the page.
 */
export const AI_CRAWLER_BUCKETS = [
  'gptbot', 'oai-searchbot', 'chatgpt-user',
  'claudebot', 'claude-searchbot', 'claude-user',
  'perplexitybot', 'perplexity-user',
  'bytespider', 'amazonbot', 'meta-externalagent', 'google-other',
] as const satisfies readonly CrawlerBucket[]

/**
 * Classical search crawlers.
 *
 * Kept separate on purpose, and the separation is a judgement call worth
 * stating: Googlebot content does reach AI Overviews and Bingbot's reaches
 * Copilot, so these are not irrelevant to AI visibility. But a Googlebot fetch
 * is not evidence that an answer engine retrieved the page, and counting it as
 * such would hide exactly the gap Report 3 exists to find — the common real
 * finding is a site Google crawls completely and GPTBot barely touches.
 *
 * `spoor report blind-spots --include-search` counts them.
 */
export const SEARCH_BUCKETS = ['googlebot', 'bingbot', 'applebot'] as const satisfies readonly CrawlerBucket[]

export function isAiCrawler(bucket: CrawlerBucket): boolean {
  return (AI_CRAWLER_BUCKETS as readonly string[]).includes(bucket)
}
