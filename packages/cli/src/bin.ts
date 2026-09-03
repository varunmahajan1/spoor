#!/usr/bin/env node
/**
 * spoor — see which AI crawlers actually reached your site.
 *
 * PRD PI-8: the whole pipeline runs locally against a file sink with no network
 * egress. If the quickstart needs an account, the tool has failed.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLASSIFIER_VERSION, RANGES_VERSION, RANGES_UPDATED_AT, rangesArePopulated, BUCKETS } from '@spoor/core'
import { fileSink } from '@spoor/sinks/node'
import { connect, createEventsView, paths, query, lit, remoteFromEnv, attachRemote, remoteGlob } from './store.js'
import { blindSpots, coverage, byPurpose, verification, reachByAgent } from './report.js'
import { readSitemap } from './sitemap.js'
import { demoEvents } from './demo.js'

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'help'
const sub = argv[1]

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  return argv[i + 1]?.startsWith('--') ? '' : argv[i + 1]
}
const has = (name: string) => argv.includes(`--${name}`)

const root = flag('dir') ?? '.spoor'
const P = paths(root)

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`

function table(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) { console.log(dim('  (no rows)')); return }
  const cols = Object.keys(rows[0]!)
  const str = (v: unknown) => v === null || v === undefined ? '' : String(v)
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => str(r[c]).length)))
  const line = (cells: string[]) => '  ' + cells.map((c, i) => c.padEnd(w[i]!)).join('  ')
  console.log(dim(line(cols)))
  console.log(dim(line(w.map((n) => '─'.repeat(n)))))
  for (const r of rows) console.log(line(cols.map((c) => str(r[c]))))
}

const HELP = `
${bold('spoor')} — which AI crawlers actually reached your site, and which pages they never did

${bold('Usage')}
  spoor <command> [options]

${bold('Commands')}
  init                    Write a config and print the middleware snippet
  demo                    Generate sample traffic so you can see real output now
  doctor                  Check the classifier, the range list and the store
  rollup                  Roll NDJSON up into Parquet, deduped on event_id
  report blind-spots      URLs you publish that no AI crawler has ever fetched
  report coverage         Which crawlers fetched what, and how much was throttled
  report purpose          Training vs indexing vs a live user waiting on an answer
  report verification     How many rows are verified, and by which method
  query "<sql>"           Any SQL over the event store
  ranges update           Refresh the published IP ranges used for verification

${bold('Options')}
  --dir <path>            Store directory (default .spoor)
  --sitemap <url>         Sitemap for blind-spots
  --limit <n>             Row limit (default 40)
  --json                  Machine-readable output

${bold('Quickstart')}
  npx spoor demo && npx spoor report blind-spots --sitemap ./demo-sitemap
`

async function withStore<T>(fn: (conn: Awaited<ReturnType<typeof connect>>, n: number) => Promise<T>): Promise<T> {
  const conn = await connect()
  const remote = remoteFromEnv()
  if (remote) {
    const failure = await attachRemote(conn, remote)
    if (failure) {
      // Reporting this loudly matters: an unreadable remote store would
      // otherwise produce an empty result that reads as "no crawlers came".
      console.error(red(`Could not read ${remoteGlob(remote)}: ${failure}`))
      console.error(dim('  Reports below cover local events only.'))
      const n = await createEventsView(conn, P)
      return fn(conn, n)
    }
  }
  const n = await createEventsView(conn, P, remote)
  return fn(conn, n)
}

function emit(rows: Record<string, unknown>[]): void {
  if (has('json')) console.log(JSON.stringify(rows, (_k, v) => typeof v === 'bigint' ? Number(v) : v, 2))
  else table(rows)
}

async function main(): Promise<number> {
  switch (cmd) {
    case 'init': {
      mkdirSync(root, { recursive: true })
      const cfg = join(root, 'config.json')
      if (!existsSync(cfg)) {
        writeFileSync(cfg, JSON.stringify({ sink: { type: 'file', dir: P.events }, dropHumans: true, retainQuery: false }, null, 2) + '\n')
      }
      console.log(`${green('✓')} ${cfg}\n`)
      console.log(bold('Add to middleware.ts:\n'))
      console.log(`  import { createRecorder, record, preset } from '@spoor/middleware'
  import { fileSink } from '@spoor/sinks/node'

  // preset: 'next' | 'vite' | 'astro' — decides what is an asset, not a page.
  const site = preset('vite', 'vercel-middleware')

  const spoor = createRecorder({
    sink: fileSink({ dir: '${P.events}' }),
    ...site,
    onError: (e) => console.error('[spoor]', e),   // never fail silently
  })

  export default function middleware(request: Request, ctx) {
    record(spoor, request, (p) => ctx.waitUntil(p))  // never blocks, never throws
    return next()
  }

  // Same preset, so the matcher cannot disagree with what is ignored.
  export const config = { matcher: site.matcher }
`)
      return 0
    }

    case 'demo': {
      const demoPaths = ['/', '/about', '/pricing', '/blog', '/blog/how-we-built-it', '/blog/ai-crawlers',
        '/products/widget', '/products/gadget', '/products/doohickey', '/products/thingamajig',
        '/docs', '/docs/install', '/docs/api', '/contact', '/careers']
      const events = demoEvents(demoPaths)
      await fileSink({ dir: P.events }).write(events)
      writeFileSync('demo-sitemap', demoPaths.join('\n') + '\n')
      console.log(`${green('✓')} ${events.length} demo events → ${P.events}`)
      console.log(`${green('✓')} demo-sitemap (${demoPaths.length} paths)\n`)
      console.log(dim('  These are synthetic, surface = "test". Next:'))
      console.log(`  npx spoor report blind-spots --sitemap ./demo-sitemap`)
      return 0
    }

    case 'doctor': {
      console.log(bold('\nspoor doctor\n'))
      let problems = 0

      console.log(`  classifier      ${CLASSIFIER_VERSION}  ${dim(`${BUCKETS.length} buckets`)}`)

      // VF-5: an unpopulated or stale range list produces false `unverified`,
      // which reads to a reader as spoofing. It is a setup problem and must be
      // reported as one rather than left to look like a finding.
      if (!rangesArePopulated()) {
        console.log(`  ranges          ${red('not fetched')}  ${dim('→ npm run ranges:update')}`)
        console.log(`                  ${yellow('every row will read `unverified`, which is not the same as spoofed')}`)
        problems++
      } else {
        const age = RANGES_UPDATED_AT ? Math.floor((Date.now() - Date.parse(RANGES_UPDATED_AT)) / 86_400_000) : null
        const stale = age !== null && age > 30
        console.log(`  ranges          ${RANGES_VERSION}  ${dim(age === null ? '' : `${age}d old`)}  ${stale ? yellow('stale') : green('ok')}`)
        if (stale) problems++
      }

      const remote = remoteFromEnv()
      console.log(`  remote store    ${remote ? `s3://${remote.bucket}/${remote.prefix}` : dim('not configured (local only)')}`)
      const n = await withStore(async (_c, count) => count)
      const anyLocal = existsSync(P.events) || existsSync(P.parquet)
      console.log(`  store           ${anyLocal || remote ? `${n} events` : dim('empty — no events collected yet')}`)
      console.log(problems === 0 ? `\n${green('  no problems')}\n` : `\n  ${yellow(`${problems} problem(s)`)}\n`)
      return problems === 0 ? 0 : 1
    }

    case 'rollup': {
      if (!existsSync(P.events)) { console.error(red('no events to roll up')); return 1 }
      mkdirSync(P.parquet, { recursive: true })
      const conn = await connect()
      await createEventsView(conn, { ...P, parquet: join(P.parquet, '__none__') })
      // PI-2/PI-7: writes a new generation rather than mutating one, so a
      // re-run with a newer classifier_version is safe and reversible.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const out = join(P.parquet, `gen-${stamp}`)
      mkdirSync(out, { recursive: true })
      await conn.run(`COPY (SELECT * EXCLUDE (_rn) FROM events) TO ${lit(out)}
        (FORMAT PARQUET, PARTITION_BY (ts_date), OVERWRITE_OR_IGNORE)`.replace('ts_date', "CAST(ts AS DATE)"))
        .catch(async () => {
          // Older DuckDB builds reject an expression in PARTITION_BY.
          await conn.run(`COPY (SELECT * EXCLUDE (_rn) FROM events) TO ${lit(join(out, 'events.parquet'))} (FORMAT PARQUET)`)
        })
      const [row] = await query<{ n: bigint }>(conn, 'SELECT count(*) AS n FROM events')
      console.log(`${green('✓')} ${Number(row?.n ?? 0)} deduped events → ${out}`)
      return 0
    }

    case 'report': {
      const limit = Number(flag('limit') ?? 40)
      return withStore(async (conn, n) => {
        if (n === 0) {
          console.log(dim('\n  No events yet. `npx spoor demo` generates sample traffic.\n'))
          return 0
        }
        switch (sub) {
          case 'blind-spots': {
            const src = flag('sitemap')
            if (!src) { console.error(red('--sitemap <url|file> is required')); return 1 }
            const published = src.startsWith('http')
              ? (await readSitemap(src)).paths
              : (await import('node:fs')).readFileSync(src, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
            const includeSearch = has('include-search')
            const rows = await blindSpots(conn, published, { includeSearch })
            const scope = includeSearch ? 'no crawler at all' : 'no AI answer engine'
            const pct = published.length ? Math.round((rows.length / published.length) * 100) : 0
            console.log(`\n${bold('Blind spots')} ${dim(`— published URLs ${scope} has fetched`)}`)
            console.log(`  ${bold(`${rows.length} of ${published.length}`)} published URLs ${dim(`(${pct}%)`)}, from ${n} events\n`)
            emit(rows.slice(0, limit))
            if (rows.length > limit) console.log(dim(`\n  … ${rows.length - limit} more`))
            if (!includeSearch) {
              console.log(`\n${bold('Reach by answer engine')}\n`)
              emit(await reachByAgent(conn, published.length))
              console.log(dim('\n  Googlebot and Bingbot are excluded above: a search crawl is not'))
              console.log(dim('  evidence an answer engine saw the page. --include-search counts them.'))
            }
            console.log()
            return 0
          }
          case 'coverage':     console.log(`\n${bold('Crawler coverage')}\n`); emit(await coverage(conn)); console.log(); return 0
          case 'purpose':      console.log(`\n${bold('By purpose')} ${dim('— train vs index vs a live user waiting')}\n`); emit(await byPurpose(conn)); console.log(); return 0
          case 'verification': console.log(`\n${bold('Verification')}\n`); emit(await verification(conn)); console.log(); return 0
          default: console.error(`unknown report: ${sub ?? '(none)'}`); return 1
        }
      })
    }

    case 'query': {
      const sql = argv.slice(1).find((a) => !a.startsWith('--'))
      if (!sql) { console.error(red('usage: spoor query "SELECT ..."')); return 1 }
      return withStore(async (conn) => { emit(await query(conn, sql)); return 0 })
    }

    case 'ranges': {
      if (sub !== 'update') { console.error('usage: spoor ranges update'); return 1 }
      console.log(dim('Run `npm run ranges:update` from the repo root (it rewrites bundled data).'))
      return 0
    }

    default:
      console.log(HELP)
      return cmd === 'help' || has('help') ? 0 : 1
  }
}

main().then((code) => { process.exitCode = code }).catch((err) => {
  console.error(red(`spoor: ${err instanceof Error ? err.message : String(err)}`))
  process.exitCode = 1
})
