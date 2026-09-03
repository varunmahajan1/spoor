import type { DuckDBConnection } from '@duckdb/node-api'
import { query, lit } from './store.js'
import { AI_CRAWLER_BUCKETS, SEARCH_BUCKETS } from '@spoor/core'

export interface BlindSpot { path: string; [key: string]: unknown }

/**
 * Report 3 — blind spots. PRD §13: the most sellable of the four and the
 * cheapest to compute, because it needs no citation join. Build it first.
 *
 * The question: which URLs that you publish has no AI crawler ever fetched?
 */
export interface BlindSpotOptions {
  /** Count Googlebot/Bingbot/Applebot as coverage too. Off by default: a
   *  Googlebot fetch is not evidence that an answer engine saw the page, and
   *  counting it hides the most common real finding — a site Google crawls
   *  completely and GPTBot barely touches. */
  includeSearch?: boolean
}

export async function blindSpots(
  conn: DuckDBConnection,
  sitemapPaths: readonly string[],
  options: BlindSpotOptions = {},
): Promise<BlindSpot[]> {
  if (sitemapPaths.length === 0) return []
  const counted = options.includeSearch
    ? [...AI_CRAWLER_BUCKETS, ...SEARCH_BUCKETS]
    : AI_CRAWLER_BUCKETS
  const inList = counted.map((b) => lit(b)).join(', ')
  const values = sitemapPaths.map((p) => `(${lit(p)})`).join(',')
  await conn.run(`CREATE OR REPLACE TEMP TABLE published(path VARCHAR); INSERT INTO published VALUES ${values};`)
  return query<BlindSpot>(conn, `
    SELECT p.path
    FROM published p
    LEFT JOIN (
      SELECT DISTINCT path FROM events
      WHERE crawler_bucket IN (${inList})
        AND status >= 200 AND status < 300   -- a 429 is not a crawl (WB-1)
    ) e ON e.path = p.path
    WHERE e.path IS NULL
    ORDER BY p.path
  `)
}

/** What each answer engine did reach, so a blind spot has context. */
export async function reachByAgent(conn: DuckDBConnection, published: number) {
  const inList = AI_CRAWLER_BUCKETS.map((b) => lit(b)).join(', ')
  return query(conn, `
    SELECT crawler_bucket AS agent, crawler_purpose AS purpose,
           count(DISTINCT path) AS urls_reached,
           round(100.0 * count(DISTINCT path) / ${published || 1}, 1) AS pct_of_sitemap
    FROM events
    WHERE crawler_bucket IN (${inList}) AND status >= 200 AND status < 300
    GROUP BY 1, 2 ORDER BY urls_reached DESC
  `)
}

/** Report 1 — coverage, grouped by the field that matters (PRD §8.3). */
export async function coverage(conn: DuckDBConnection) {
  return query(conn, `
    SELECT
      crawler_bucket                                              AS bucket,
      crawler_purpose                                             AS purpose,
      count(*)                                                    AS hits,
      count(DISTINCT path)                                        AS urls,
      -- RP-2: the three zeros must never collapse into one number.
      count(*) FILTER (WHERE status >= 200 AND status < 300)      AS ok,
      count(*) FILTER (WHERE status = 429)                        AS throttled,
      count(*) FILTER (WHERE status >= 400 AND status <> 429)     AS errors,
      count(*) FILTER (WHERE crawler_verified)                    AS verified,
      min(ts)                                                     AS first_seen,
      max(ts)                                                     AS last_seen
    FROM events
    WHERE crawler_bucket <> 'human'
    GROUP BY 1, 2
    ORDER BY hits DESC
  `)
}

/** The split the whole schema exists to preserve: training vs index vs a live
 *  user waiting on an answer. */
export async function byPurpose(conn: DuckDBConnection) {
  return query(conn, `
    SELECT crawler_purpose AS purpose, count(*) AS hits, count(DISTINCT path) AS urls,
           count(DISTINCT crawler_bucket) AS agents
    FROM events WHERE crawler_bucket <> 'human'
    GROUP BY 1 ORDER BY hits DESC
  `)
}

/** Verification health. VF-5: a stale range list produces false `unverified`,
 *  which reads to a reader as spoofing. */
export async function verification(conn: DuckDBConnection) {
  return query(conn, `
    SELECT verified_by, count(*) AS rows, count(DISTINCT crawler_bucket) AS buckets
    FROM events WHERE crawler_bucket <> 'human'
    GROUP BY 1 ORDER BY rows DESC
  `)
}
