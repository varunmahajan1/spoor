/**
 * MCP server over the spoor event store — PRD MC-2, MC-3.
 *
 * MCP as a *source* does not work: no platform exposes storefront request logs
 * over MCP, so it would be an interface with no implementations (MC-1). MCP as
 * a *query layer over what you have already collected* is the point — any
 * coding agent can ask "which product URLs has GPTBot never fetched?" and get
 * an answer from real data.
 *
 * It costs almost nothing on top of the DuckDB layer the reports need anyway.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { CLASSIFIER_VERSION, RANGES_VERSION, RANGES_UPDATED_AT, rangesArePopulated } from '@spoor/core'
import { connect, createEventsView, paths, query, blindSpots, coverage, byPurpose, verification, readSitemap } from 'spoor'

const json = (value: unknown) => ({
  content: [{
    type: 'text' as const,
    text: JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2),
  }],
})

/** A read-only guard. The store is the operator's own data, but an agent
 *  driving this should not be able to mutate or attach to anything. */
const FORBIDDEN = /\b(attach|copy|create|delete|drop|insert|update|install|load|export|pragma|set\s)\b/i

export function createServer(storeRoot = '.spoor'): McpServer {
  const P = paths(storeRoot)
  const server = new McpServer({ name: 'spoor', version: '0.1.0' })

  const open = async () => {
    const conn = await connect()
    const n = await createEventsView(conn, P)
    return { conn, n }
  }

  server.tool(
    'spoor_status',
    'Classifier version, published-IP-range freshness and how many crawler events the store holds. Call this first: an unpopulated range list makes every row read `unverified`, which is a setup problem, not a finding about the crawler.',
    {},
    async () => {
      const { n } = await open()
      return json({
        classifier_version: CLASSIFIER_VERSION,
        ranges_version: RANGES_VERSION,
        ranges_updated_at: RANGES_UPDATED_AT,
        ranges_populated: rangesArePopulated(),
        events: n,
        store: storeRoot,
      })
    },
  )

  server.tool(
    'spoor_blind_spots',
    'URLs the site publishes that no AI crawler has ever successfully fetched. Takes a sitemap URL or a list of paths. This is the flagship report: it needs no citation data, only the logs and the sitemap.',
    {
      sitemap: z.string().optional().describe('Sitemap URL, e.g. https://example.com/sitemap.xml'),
      paths: z.array(z.string()).optional().describe('Published paths, if you already have them'),
    },
    async ({ sitemap, paths: given }) => {
      const published = given ?? (sitemap ? (await readSitemap(sitemap)).paths : [])
      if (published.length === 0) {
        return json({ error: 'Provide either `sitemap` or `paths`.' })
      }
      const { conn, n } = await open()
      const rows = await blindSpots(conn, published)
      return json({
        published: published.length,
        never_crawled: rows.length,
        events_considered: n,
        paths: rows.map((r) => r.path),
      })
    },
  )

  server.tool(
    'spoor_coverage',
    'Which AI crawlers fetched what, how often, how many distinct URLs, and how many requests were throttled (429) versus served. Throttled and never-crawled are different findings and this keeps them apart.',
    {},
    async () => { const { conn } = await open(); return json(await coverage(conn)) },
  )

  server.tool(
    'spoor_by_purpose',
    'Traffic split by crawler intent: `train` (building a corpus), `index` (building a search index), `user_fetch` (a live user is waiting on this answer right now). A user_fetch is the closest thing in the logs to a citation event.',
    {},
    async () => { const { conn } = await open(); return json(await byPurpose(conn)) },
  )

  server.tool(
    'spoor_verification',
    'How many rows had their claimed crawler identity verified, and by which method (published IP range, reverse DNS, Cloudflare bot management, or unverified). User agents are trivially spoofed, so an unverified row is a claim, not a fact.',
    {},
    async () => { const { conn } = await open(); return json(await verification(conn)) },
  )

  server.tool(
    'spoor_query',
    'Run read-only SQL against the `events` table. Columns: event_id, ts, host, method, path, query, status, bytes, duration_ms, cache_status, user_agent, crawler_bucket, crawler_purpose, crawler_verified, verified_by, classifier_version, referer, ip_prefix, surface. Rows are already deduplicated on event_id.',
    { sql: z.string().describe('A SELECT statement over `events`') },
    async ({ sql }) => {
      if (FORBIDDEN.test(sql)) {
        return json({ error: 'Read-only: only SELECT statements over `events` are permitted.' })
      }
      const { conn } = await open()
      try {
        return json(await query(conn, sql))
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) })
      }
    },
  )

  return server
}
