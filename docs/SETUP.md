# Setup

From nothing to a real report. Roughly 15 minutes for local, plus a Cloudflare
R2 bucket if you are deploying to a platform with an ephemeral filesystem
(Vercel, Workers, most containers).

> **Not on npm yet.** v0.1 installs from source. Where this guide shows
> `spoor ...`, that is `node /path/to/spoor/packages/cli/dist/bin.js ...`, or use
> the alias below.

---

## 1. Install

```bash
git clone https://github.com/varunmahajan1/spoor.git
cd spoor
npm install
npm run build
npm test              # 90 tests, ~1s

alias spoor="node $(pwd)/packages/cli/dist/bin.js"
```

Requires Node 22 or newer.

### See it work before instrumenting anything

```bash
mkdir -p /tmp/spoor-demo && cd /tmp/spoor-demo
spoor demo
spoor report blind-spots --sitemap ./demo-sitemap
```

Synthetic traffic, shaped like the common real case: Googlebot reaches
everything, the answer engines reach a fraction. `surface` is `test` on every
row, so demo data can never be confused with collected data.

## 2. Fetch the verification data

```bash
cd /path/to/spoor
npm run ranges:update
npm run build
```

This pulls each operator's **published IP ranges** -- about 1000 prefixes across
12 crawlers -- so a claimed identity can be checked rather than trusted. User
agents are trivially spoofed.

Skipping it is not neutral: every row reads `unverified`, which looks like
spoofing rather than like missing setup. `spoor doctor` reports it as a setup
problem for exactly that reason.

```bash
spoor doctor
```

```
  classifier      2026-09-04  17 buckets
  ranges          2026-09-03  0d old  ok
  remote store    not configured (local only)
  store           0 events
```

## 3. Add the middleware

```bash
npm i @spoor/next @spoor/sinks     # or `npm link` from a local clone for now
```

```ts
// middleware.ts
import { NextResponse } from 'next/server'
import { createRecorder, record } from '@spoor/next'
import { fileSink } from '@spoor/sinks/node'

const spoor = createRecorder({
  sink: fileSink({ dir: '.spoor/events' }),
  onError: (e) => console.error('[spoor]', e),
})

export function middleware(request: Request) {
  record(spoor, request)
  return NextResponse.next()
}

export const config = {
  // Match pages, not assets. Crawler behaviour on a JS chunk says nothing.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

`record()` never blocks the response and never throws into it. If the sink is
down, a batch is dropped and the page still serves -- there is
[a test asserting exactly that](../packages/next/test/fail-open.test.ts).

Confirm it locally. Start your dev server, then:

```bash
curl -A "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" \
  http://localhost:3000/
cat .spoor/events/*.ndjson | head -1
```

You should see one JSON line with `"crawler_bucket":"gptbot"` and
`"crawler_purpose":"train"`. Your own browser hits produce nothing: human rows
are dropped at source by default.

## 4. Production storage

> **The file sink does not work on Vercel.** The filesystem is read-only apart
> from `/tmp`, and `/tmp` does not survive a cold start. Anything written there
> is gone before you read it. The same is true of Cloudflare Workers and of any
> container replaced on deploy.

Use the S3 sink. **Cloudflare R2 speaks the S3 API, so one sink covers both** --
R2 is usually the cheaper choice here because it has no egress fees.

### Create an R2 bucket

1. Cloudflare dashboard -> **R2** -> **Create bucket** (call it `spoor`)
2. **Manage R2 API Tokens** -> **Create API token** -> *Object Read & Write*,
   scoped to that bucket
3. Keep the Access Key ID, the Secret Access Key, and your Account ID

### Point the middleware at it

```ts
import { createRecorder, record } from '@spoor/next'
import { s3Sink } from '@spoor/sinks'

const spoor = createRecorder({
  sink: s3Sink({
    bucket: 'spoor',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    region: 'auto',
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  }),
  onError: (e) => console.error('[spoor]', e),
})
```

```bash
vercel env add R2_ACCOUNT_ID
vercel env add R2_ACCESS_KEY_ID
vercel env add R2_SECRET_ACCESS_KEY
```

The sink signs its own requests with SigV4 over Web Crypto -- no AWS SDK, so it
adds nothing meaningful to the middleware bundle.

Each batch is written as one object under `events/YYYY-MM-DD/`. Object stores
have no append, and read-modify-write from concurrent isolates would lose
events. Many small objects cost nothing: the reports deduplicate on `event_id`.

### Read it back

```bash
export SPOOR_S3_BUCKET=spoor
export SPOOR_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
export SPOOR_S3_REGION=auto
export SPOOR_S3_ACCESS_KEY_ID=...
export SPOOR_S3_SECRET_ACCESS_KEY=...

spoor doctor
spoor report coverage
```

Credentials come from the environment rather than from flags, so they stay out
of shell history. DuckDB reads the objects in place; there is no download step.

## 5. Your first real report

Give it time. **Crawlers arrive over days, not minutes** -- a new or rarely
updated page may wait a week for GPTBot. A report run an hour after deploying
tells you nothing except that the pipeline works.

```bash
spoor report coverage
```

Confirms collection is working, and shows which agents have appeared.

```bash
spoor report blind-spots --sitemap https://yoursite.com/sitemap.xml
```

The flagship: URLs you publish that **no answer engine has fetched**.

Googlebot and Bingbot are excluded by default. A Google crawl is not evidence
that an answer engine saw the page, and counting it hides the most common real
finding -- a site Google crawls completely and GPTBot barely touches. Add
`--include-search` to count them.

```bash
spoor report purpose        # training vs indexing vs a live user waiting
spoor report verification   # how many rows are proven, and by which method
spoor rollup                # NDJSON to Parquet, once you have real volume
```

## 6. Ask your coding agent

```jsonc
// .mcp.json in your project
{
  "mcpServers": {
    "spoor": {
      "command": "node",
      "args": ["/path/to/spoor/packages/mcp/dist/bin.js"],
      "env": { "SPOOR_S3_BUCKET": "spoor", "SPOOR_S3_ENDPOINT": "https://..." }
    }
  }
}
```

Then ask, in plain language: *"which product URLs has GPTBot never fetched?"* or
*"did any crawler get rate-limited last week?"*

Tools: `spoor_status`, `spoor_blind_spots`, `spoor_coverage`, `spoor_by_purpose`,
`spoor_verification`, `spoor_query` (read-only SQL).

## Troubleshooting

**No events at all.** Check the middleware `matcher` covers the paths you expect,
and remember that human rows are dropped by default. Set `dropHumans: false`
temporarily and hit the site yourself to confirm the pipeline works end to end.

**Events locally but not in production.** Almost always the file sink on an
ephemeral filesystem -- see section 4.

**Every row says `unverified`.** Run `npm run ranges:update && npm run build`,
then `spoor doctor`. If it persists for one crawler only, that operator may not
publish ranges (Bytespider does not), which is a real `unverified`, not a bug.

**`Could not read s3://...`.** DuckDB needs its `httpfs` extension, which it
downloads on first use. On an offline machine, reports fall back to local events
and say so rather than silently returning nothing.

**Counts look too high.** They should not -- the store view deduplicates on
`event_id`. If they still look wrong, `spoor query "SELECT count(*),
count(DISTINCT event_id) FROM events"` should return two equal numbers.

**Nothing in the sitemap is a blind spot.** Check the paths match: the report
joins on exact path, so a trailing-slash mismatch between your sitemap and your
routes reads as full coverage.

## What to expect

| | |
|---|---|
| Hours | Googlebot and Bingbot, on an established site |
| Days | GPTBot, ClaudeBot, PerplexityBot |
| Weeks | Enough `user_fetch` traffic to mean anything |
| Never | Crawlers your `robots.txt` blocks -- check that first |

Before drawing a conclusion from a zero, rule out the other two zeros:
**blocked** (robots.txt or CDN), and **throttled** (a 429 -- Shopify rate-limits
unsigned bots since 30 May 2026). `spoor report coverage` breaks out throttled
separately for this reason.
