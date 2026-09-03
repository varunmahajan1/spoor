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

## 2b. Preflight

Before instrumenting anything:

```bash
spoor preflight https://yoursite.com
```

```
  ok    reachable        200 as a browser
  ok    gptbot           200
  ok    claudebot        200
  ok    robots.txt       no AI crawler disallowed
  FAIL  body content     0 chars of text, but <title> is set — client-rendered,
                         so crawlers get an empty page
  ok    sitemap.xml      46 URLs — use this for blind-spots
```

Three things it answers that logs never will. Whether an AI crawler is served
the same thing a browser is, or a 403 at the edge. Whether `robots.txt` blocks
one. And **whether there is any body content for a client that runs no
JavaScript** — a client-rendered SPA answers 200 to GPTBot and serves an empty
page, so a perfect coverage report would describe successful retrieval of
nothing.

Fix a `FAIL` here before instrumenting: otherwise the logs record the
consequence rather than the cause.

## 3. Add the middleware

One adapter for every fetch-shaped runtime. Two things vary, and they vary
independently:

| | Set by | What it decides |
|---|---|---|
| **Preset** | your framework | which paths are build output, not pages |
| **Surface** | your host | where the row was collected, so it stays comparable |

```bash
npm i @spoor/middleware @spoor/sinks   # or `npm link` from a local clone for now
```

### Vite (React, Vue, Svelte) on Vercel

```ts
// middleware.ts — project root, beside vite.config.ts
import { next } from '@vercel/functions'
import { createRecorder, record, preset } from '@spoor/middleware'
import { s3Sink } from '@spoor/sinks'

const site = preset('vite', 'vercel-middleware')

const spoor = createRecorder({
  sink: s3Sink({
    bucket: 'spoor',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    region: 'auto',
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  }),
  ...site,
  onError: (e) => console.error('[spoor]', e),
})

export default function middleware(request: Request, ctx) {
  record(spoor, request, (p) => ctx.waitUntil(p))
  return next()
}

export const config = { matcher: site.matcher }
```

Vercel middleware runs on any project, framework or not, and it runs **before
the cache**. On a static site that is the only position where this works at all:
a logger running after the cache would see almost nothing.

### Next.js, Astro, or no framework

Same file, different preset:

```ts
const site = preset('next', 'vercel-middleware')    // or 'astro', or 'none'
```

Self-hosting Next on your own server rather than Vercel? Use
`preset('next', 'next-middleware')` — the surface differs because the collection
point does, and rows are only comparable when that is recorded honestly.

### Why the preset is load-bearing

Each framework serves build output from its own prefix:

| Preset | Ignores |
|---|---|
| `vite` | `/assets/` |
| `next` | `/_next/static/`, `/_next/image`, `/__nextjs` |
| `astro` | `/_astro/` |
| all | `/favicon.*`, `/apple-touch-icon` |

Use the wrong one and every bundle request is recorded as a page fetch. The
blind-spots report then shows full coverage — of URLs no crawler ever asked for.

`robots.txt`, `sitemap.xml` and `llms.txt` are **never** ignored. A crawler
fetching one of those is the crawler telling you what it intends to do next.

### The matcher is a cost control, not tidiness

`ignore` keeps assets out of storage. `config.matcher` keeps them from being
invoked at all — and on Vercel **every matched request is a billed invocation**.
On a bundle-heavy SPA that is easily a 3x difference in invocation count.

Both come from `preset()`, generated from one list, so they cannot drift. There
is [a test proving the agreement](../packages/middleware/test/presets.test.ts)
across every preset and a corpus of real paths.

### Confirm it locally

Start your dev server, then:

```bash
curl -A "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" \
  http://localhost:3000/
cat .spoor/events/*.ndjson | head -1
```

You should see one JSON line with `"crawler_bucket":"gptbot"` and
`"crawler_purpose":"train"`. Your own browser hits produce nothing: human rows
are dropped at source by default. Requests to `/assets/*` produce nothing
either — that is the preset working.

### One field this surface always leaves alone

`cache_status` is recorded as `unknown`, and that is correct rather than a gap.
The schema carries the field because a response served from cache *without*
invoking the logger is an unlogged visit. Here the inverse holds: middleware
runs before the cache, so at record time the status does not exist yet —
`x-vercel-cache` is a *response* header. Inferring a value would invent a fact.

## 3b. Cloudflare, and Shopify

Standard Shopify has no first-party route — apps are admin-side, pixels are
client-side and AI crawlers run no JavaScript, and Liquid cannot read the user
agent. The only position left is a Cloudflare zone in front of the storefront.

**Read [docs/DESIGN.md §2.2](DESIGN.md) before doing this on a live store.**
Cloudflare documents Orange-to-Orange for Shopify on any plan including Free;
Shopify's own position is that Cloudflare proxy setups, O2O included, are not
supported and "could break at any time". Cloudflare documents it, Shopify
disclaims it. That is a real tradeoff on a revenue-bearing storefront.

```ts
// worker.ts
import { createWorker } from '@spoor/worker'
import { r2BindingSink } from '@spoor/sinks'

export default createWorker((env) => ({
  sink: r2BindingSink({ bucket: env.SPOOR_BUCKET }),
  onError: (e) => console.error('[spoor]', e),
}))
```

```toml
# wrangler.toml
name = "spoor"
main = "worker.ts"
compatibility_date = "2026-01-01"

[[r2_buckets]]
binding = "SPOOR_BUCKET"
bucket_name = "spoor"

# Optional kill switch — set spoor:enabled = "off" to stop collection
# without a redeploy. The read is edge-cached and fails open.
[[kv_namespaces]]
binding = "SPOOR_KV"
id = "..."
```

Two settings to get right, both from Cloudflare's own Shopify guide:

- **Do not enable "Always Use HTTPS."** It redirects
  `/.well-known/acme-challenge/*` and breaks certificate renewal. Use a redirect
  rule that excludes that path.
- **Check the AI bot setting after the DNS move.** Cloudflare's "manage AI bot
  traffic" feature writes the AI block by default, and a site can be invisible
  to ChatGPT with nobody having chosen it. Moving DNS to install spoor and then
  measuring zero traffic you caused is the failure that discredits the tool.
  `spoor preflight` checks exactly this — run it before and after.

Workers are disabled on `/checkout` under O2O, and this adapter refuses to touch
it on any origin. Crawlers never request checkout, so nothing is lost.

## 3c. Self-hosted, Magento, WooCommerce with shell access

Vector tails the access log and writes a local spool; spoor classifies it.
Vector deliberately does no classification — a second ruleset written in VRL
would drift from the real one, which is the failure the versioned ruleset exists
to prevent. It is shipped as a config, not as software.

```bash
cp vector/nginx.toml /etc/vector/spoor.toml     # or vector/apache.toml
vector --config /etc/vector/spoor.toml

# On the same host, on a timer:
spoor ingest /var/spool/spoor
```

**Run `spoor ingest` on the log host.** That is what keeps the full IP on your
infrastructure: it is read there for range verification, then truncated before
anything is written. Shipping raw addresses to a central collector first would
defeat the point of truncating them at all.

One property worth knowing: on log-derived surfaces the event id is a content
hash, so a restarted shipper re-reading old lines cannot double-count. The cost
is that two genuinely distinct requests agreeing on timestamp, /24, path, user
agent and status collapse into one row — undercounting a burst, never
overcounting. Push surfaces mint a UUID per request and cannot collide.

## 3d. WordPress and WooCommerce on managed hosting

No shell means no Vector, so this is a PHP mu-plugin. It shares no code with the
rest of spoor — it cannot, PHP and TypeScript do not mix — but it reads the same
`ruleset.json`, copied verbatim rather than retyped. The test suite checks its
classification, IP truncation and event ids against values generated by the
TypeScript implementation, because two implementations of one ruleset that
disagree would quietly stop the roll-up deduplicating.

```
wp-content/mu-plugins/
  spoor.php
  spoor-data/
    ruleset.json
    ranges.json
```

Files in `mu-plugins/` load automatically — no activation step, and no way for a
site owner to disable it from the admin.

### Where the spool goes, and why it matters

Rows are written as NDJSON to a spool directory. **On most managed hosting the
only writable place is `wp-content/uploads/`, which WordPress serves publicly.**
The plugin defends that three ways: a per-site random directory suffix, an
Apache `.htaccess` denying the directory, and an `index.php` against autoindex.

**nginx does not read `.htaccess`.** If you are on nginx, do one of these:

```nginx
location ~* /uploads/spoor-[0-9a-f]+/ { deny all; return 404; }
```

or put the spool outside the web root entirely, which is better if you can:

```php
// wp-config.php
define('SPOOR_SPOOL_DIR', '/home/you/private/spoor');
```

### Getting the data out

Unlike Vector, this adapter classifies and verifies in place, so the spool is
already full schema rows. Nothing needs re-processing — move the files and read
them:

```bash
scp you@host:/home/you/private/spoor/*.ndjson .spoor/events/
spoor report coverage
```

Options, all via `wp-config.php` constants: `SPOOR_SPOOL_DIR`,
`SPOOR_KEEP_HUMANS`, `SPOOR_RETAIN_QUERY`.

### Contributing to it

The tests run in a container, so you need Docker but not PHP:

```bash
npm run test:php
```

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
import { createRecorder, record, preset } from '@spoor/middleware'
import { s3Sink } from '@spoor/sinks'

const spoor = createRecorder({
  ...preset('vite', 'vercel-middleware'),
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
