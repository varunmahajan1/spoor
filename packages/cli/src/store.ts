/**
 * DuckDB over the event store — PRD PI-5: analysis is SQL over Parquet, not a
 * dashboard product. Queries are the deliverable.
 *
 * DuckDB also writes the Parquet (PI-4 roll-up). Doing it here rather than with
 * a JavaScript Parquet writer removes the most fragile dependency this project
 * would otherwise have, using a tool the query layer needs regardless.
 */
import { DuckDBInstance } from '@duckdb/node-api'
import type { DuckDBConnection } from '@duckdb/node-api'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface StorePaths {
  root: string
  events: string
  parquet: string
}

export function paths(root = '.spoor'): StorePaths {
  return { root, events: join(root, 'events'), parquet: join(root, 'parquet') }
}

export async function connect(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(':memory:')
  return instance.connect()
}

export async function query<T = Record<string, unknown>>(
  conn: DuckDBConnection, sql: string,
): Promise<T[]> {
  const reader = await conn.runAndReadAll(sql)
  return reader.getRowObjects() as T[]
}

/** Escapes a path for a SQL string literal. */
export const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`

/**
 * A view over whatever the store holds — Parquet if the roll-up has run, raw
 * NDJSON otherwise, both if both. This is what makes `spoor report` work
 * immediately after the first request rather than only after a roll-up.
 */
export interface RemoteStore {
  bucket: string
  prefix?: string
  region?: string
  /** Cloudflare R2: https://<account>.r2.cloudflarestorage.com */
  endpoint?: string
  accessKeyId: string
  secretAccessKey: string
}

/** Reads a remote store from the environment, so credentials never become CLI
 *  arguments that end up in shell history. */
export function remoteFromEnv(env: NodeJS.ProcessEnv = process.env): RemoteStore | null {
  const bucket = env.SPOOR_S3_BUCKET
  const accessKeyId = env.SPOOR_S3_ACCESS_KEY_ID ?? env.AWS_ACCESS_KEY_ID
  const secretAccessKey = env.SPOOR_S3_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY
  if (!bucket || !accessKeyId || !secretAccessKey) return null
  return {
    bucket, accessKeyId, secretAccessKey,
    prefix: env.SPOOR_S3_PREFIX ?? 'events',
    region: env.SPOOR_S3_REGION ?? (env.SPOOR_S3_ENDPOINT ? 'auto' : 'us-east-1'),
    ...(env.SPOOR_S3_ENDPOINT ? { endpoint: env.SPOOR_S3_ENDPOINT } : {}),
  }
}

/**
 * Attaches a remote store. DuckDB's httpfs extension reads the objects
 * directly, so reports run over remote data without a download step.
 *
 * Returns a reason string when it could not be attached — a missing extension
 * on an offline machine is a setup problem and must be reported as one, not
 * silently produce an empty result that reads as "no crawlers came".
 */
export async function attachRemote(conn: DuckDBConnection, r: RemoteStore): Promise<string | null> {
  try {
    await conn.run('INSTALL httpfs; LOAD httpfs;')
    const host = r.endpoint ? new URL(r.endpoint).host : undefined
    await conn.run(`CREATE OR REPLACE SECRET spoor_s3 (
      TYPE s3,
      KEY_ID ${lit(r.accessKeyId)},
      SECRET ${lit(r.secretAccessKey)},
      REGION ${lit(r.region ?? 'us-east-1')}
      ${host ? `, ENDPOINT ${lit(host)}, URL_STYLE 'path', USE_SSL true` : ''}
    )`)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export function remoteGlob(r: RemoteStore): string {
  const prefix = (r.prefix ?? 'events').replace(/^\/+|\/+$/g, '')
  return `s3://${r.bucket}/${prefix}/**/*.ndjson`
}

export async function createEventsView(
  conn: DuckDBConnection, p: StorePaths, remote?: RemoteStore | null,
): Promise<number> {
  const parts: string[] = []
  if (remote) {
    parts.push(`SELECT * FROM read_json_auto(${lit(remoteGlob(remote))}, union_by_name = true, format = 'newline_delimited')`)
  }
  if (existsSync(p.parquet)) parts.push(`SELECT * FROM read_parquet(${lit(join(p.parquet, '**', '*.parquet'))}, union_by_name = true)`)
  if (existsSync(p.events)) parts.push(`SELECT * FROM read_json_auto(${lit(join(p.events, '*.ndjson'))}, union_by_name = true, format = 'newline_delimited')`)

  if (parts.length === 0) {
    await conn.run(`CREATE VIEW events AS SELECT * FROM (VALUES (NULL)) t(event_id) WHERE false`)
    return 0
  }

  // PI-6: the store can contain the same event twice, because batches retry.
  // Deduplicating in the view means every report is correct even before a
  // roll-up has run — a duplicated batch would otherwise inflate the crawl
  // count, which is the number being reported.
  await conn.run(`
    CREATE VIEW events AS
    SELECT * FROM (
      SELECT *, row_number() OVER (PARTITION BY event_id ORDER BY ts) AS _rn
      FROM (${parts.join(' UNION ALL BY NAME ')})
    ) WHERE _rn = 1
  `)
  const [row] = await query<{ n: bigint }>(conn, 'SELECT count(*) AS n FROM events')
  return Number(row?.n ?? 0)
}
