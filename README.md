# spoor

**Which AI crawlers actually reached your site — and which of your pages they never did.**

A spoor is the track an animal leaves. You never see AI crawlers directly: they
don't run JavaScript, so Google Analytics never records them and Search Console
doesn't report them. Server-side request data is the only source. This reads it.

```
Blind spots — published URLs no AI answer engine has fetched
  9 of 15 published URLs (60%), from 175 events

  path
  ─────────────────────
  /careers
  /contact
  /docs
  /docs/api
  /docs/install
  /products/doohickey
  /products/gadget
  /products/thingamajig
  /products/widget

Reach by answer engine

  agent             purpose     urls_reached  pct_of_sitemap
  ────────────────  ──────────  ────────────  ──────────────
  gptbot            train       6             40
  claudebot         train       6             40
  oai-searchbot     index       5             33.3
  perplexitybot     index       4             26.7
  claude-searchbot  index       3             20
  chatgpt-user      user_fetch  3             20
  claude-user       user_fetch  2             13.3
```

Runs locally. No account, no hosted service, nothing phones home.

---

## Try it

> **v0.1 — not on npm yet.** Install from source; it takes a minute.

```bash
git clone https://github.com/varunmahajan1/spoor.git
cd spoor && npm install && npm run build
npm run ranges:update && npm run build     # fetch published crawler IP ranges

alias spoor="node $(pwd)/packages/cli/dist/bin.js"

mkdir -p /tmp/spoor-demo && cd /tmp/spoor-demo
spoor demo
spoor report blind-spots --sitemap ./demo-sitemap
```

That generates synthetic traffic so you can see the output shape before
instrumenting anything. Then point it at your own site — full walkthrough in
**[docs/SETUP.md](docs/SETUP.md)**.

## Install

One adapter, any fetch-shaped runtime — Vercel, Netlify, Deno Deploy, Bun, Node.
The framework decides what counts as an asset; the host decides where collection
happens. A preset covers the first, a surface the second.

```ts
// middleware.ts — a Vite SPA on Vercel
import { next } from '@vercel/functions'
import { createRecorder, record, preset } from '@spoor/middleware'
import { s3Sink } from '@spoor/sinks'

const site = preset('vite', 'vercel-middleware')   // or 'next' | 'astro'

const spoor = createRecorder({
  sink: s3Sink({ /* R2 — see docs/SETUP.md */ }),
  ...site,
  onError: (e) => console.error('[spoor]', e),     // never fail silently
})

export default function middleware(request: Request, ctx) {
  record(spoor, request, (p) => ctx.waitUntil(p))  // never blocks, never throws
  return next()
}

// Generated from the same preset, so it cannot disagree with what is ignored.
export const config = { matcher: site.matcher }
```

**The preset is not cosmetic.** Vite emits hashed bundles to `/assets/`, Next to
`/_next/static/`, Astro to `/_astro/`. Instrument a Vite site with the Next list
and every JavaScript and CSS request is recorded as a page fetch — after which
blind-spots reads as full coverage of URLs no crawler ever asked for.

The matcher matters for a different reason: on Vercel every matched request is a
billed invocation. `ignore` saves storage, `matcher` saves compute, and both are
generated from one list so they cannot drift.

Then:

```bash
spoor doctor                                        # is anything misconfigured?
spoor report blind-spots --sitemap https://you.com/sitemap.xml
spoor report coverage
spoor rollup                                        # NDJSON → Parquet
spoor query "SELECT crawler_purpose, count(*) FROM events GROUP BY 1"
```

**Deploying to Vercel, Workers, or any container?** The file sink will not work —
those filesystems are ephemeral. Use the S3 sink, which also speaks Cloudflare
R2. [Setup guide](docs/SETUP.md#4-production-storage).

## Platform support

**Read this before installing.** Collection is not universally possible, and the
shape of the impossibility differs per platform.

| Platform | How | Status |
|---|---|---|
| Anything on Vercel or Netlify (Vite, Next, Astro, plain) | `@spoor/middleware` | ✅ Shipping |
| Any site on Cloudflare | Worker | 🚧 Next |
| **Standard Shopify** | Cloudflare in front, via O2O | ⚠️ **See below** |
| Self-hosted, Magento, WooCommerce with shell | Vector config | 🚧 Planned |
| WooCommerce on managed hosting | PHP mu-plugin | 🚧 If asked for |

### Shopify, honestly

Shopify has **no first-party route**. Apps see the admin, not storefront
requests. Web pixels are client-side, and AI crawlers don't run JavaScript.
Liquid renders server-side but cannot see the requester's user agent. App proxy
only sees its own path. There is no merchant-facing AI crawler report in the
admin. None of this is a gap we can close in code.

The only route is putting Cloudflare in front of the storefront, using
[Orange-to-Orange routing][o2o], which Cloudflare documents officially:

- Works on **any Cloudflare plan, including Free**
- Workers run on the request path — disabled only on `/checkout`, which
  crawlers never request, so it costs this tool nothing
- **Do not enable "Always Use HTTPS"**: it redirects
  `/.well-known/acme-challenge/*` and breaks certificate renewal. Use a redirect
  rule that excludes that path

**And the caveat that matters:** [Shopify's own position][shopify-domains] is
that Cloudflare proxy setups, **including O2O, are not supported**, and "could
break at any time." Cloudflare documents it; Shopify disclaims it. That is a
real tradeoff on a revenue-bearing storefront, and it is yours to make with your
eyes open. We will never document a workaround for the `/checkout` carve-out.

Also: since 30 May 2026, Shopify rate-limits unsigned bots via
[Web Bot Auth][webbotauth], and `robots.txt` does not bypass it. spoor records
429s separately for exactly this reason — see below.

[o2o]: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/provider-guides/shopify/
[shopify-domains]: https://help.shopify.com/en/manual/domains/troubleshoot-issues-with-domains
[webbotauth]: https://shopify.dev/changelog/bots-and-agents-should-identify-themselves-via-web-bot-auth

## What makes this different from a log shipper

Vector, Fluent Bit and the OpenTelemetry Collector already ship logs to S3, and
they do it better than this ever will. If you want generic log collection, use
one of those. spoor does four things they don't:

**1. It separates agents by intent, not by vendor.** OpenAI sends three distinct
crawlers and they mean different things:

| Agent | Purpose | What it means |
|---|---|---|
| `GPTBot` | `train` | Building a training corpus |
| `OAI-SearchBot` | `index` | Building a search index |
| `ChatGPT-User` | `user_fetch` | **A live user is waiting on this answer right now** |

Every bot list I've found collapses these into "OpenAI". A `user_fetch` is the
closest thing in your logs to a citation event, and bucketing it with training
traffic throws away the most interesting signal you have. Same for Anthropic
(ClaudeBot / Claude-SearchBot / Claude-User) and Perplexity.

**2. It verifies the claim.** User agents are trivially spoofed. spoor checks the
source address against each operator's published IP ranges — fetched from the
vendors, never hand-typed — and records *how* verification was established, so a
row verified one way and a row verified another stay comparable.

**3. It keeps three kinds of zero apart.** A page with no crawler traffic is one
of three findings, with three different owners:

- **blocked** — your `robots.txt` or your CDN said no
- **throttled** — the platform rate-limited the crawler (a 429, not a crawl)
- **never crawled** — nobody came

Any report that shows one number for all three is wrong in the direction that
looks like a content problem.

**4. It works where there is no file to tail.** On Vercel and Next.js there is no
access log for an agent to read.

## Ask your coding agent

```jsonc
// .mcp.json
{
  "mcpServers": {
    "spoor": { "command": "node", "args": ["/path/to/spoor/packages/mcp/dist/bin.js"] }
  }
}
```

Then ask, in whatever agent you use: *"which product URLs has GPTBot never
fetched?"* Tools: `spoor_status`, `spoor_blind_spots`, `spoor_coverage`,
`spoor_by_purpose`, `spoor_verification`, `spoor_query` (read-only SQL).

## Privacy

One paragraph, and you can verify every clause against the code:

**The full IP address never leaves your infrastructure.** It is truncated at the
point of collection — /24 for IPv4, /48 for IPv6 — and used for range
verification before being discarded. Human rows are dropped at source by
default; no report here needs them. Data goes where you configure it and
nowhere else, and there is no telemetry.

**These rows are pseudonymised, not anonymous.** A /24 prefix is still
identifying in a small population. If you are writing a privacy notice, do not
describe them as anonymous. This is a tool, not legal advice.

## How it fits together

```
sources ─┐
         ├─→  core: schema + versioned classifier + verification  ─┬─→ sinks
ingest ──┘                                                        └─→ MCP server
```

| Package | What |
|---|---|
| [`@spoor/core`](packages/core) | Schema, classifier, verification. **Zero runtime dependencies** — it is imported into edge runtimes |
| [`@spoor/middleware`](packages/middleware) | Request-path adapter for any fetch runtime, with `next` / `vite` / `astro` presets |
| [`@spoor/sinks`](packages/sinks) | File, S3/R2 (SigV4, no AWS SDK), webhook, memory |
| [`spoor`](packages/cli) | CLI: roll-up, reports, SQL |
| [`@spoor/mcp`](packages/mcp) | MCP server |

The classifier is **[a JSON data file](packages/core/data/ruleset.json)**, not
code, so an adapter written in any language reads the same source of truth. The
published IP ranges are **[fetched, never hand-written](scripts/update-ranges.mjs)** —
a scheduled job refreshes them and opens a pull request.

### On the request path

The adapters run in front of real traffic, so:

- **Non-blocking.** Logging goes through `waitUntil`; the visitor never waits
- **Fail-open.** A sink that is down drops a batch. It does not fail a request —
  and there is [a test that asserts it](packages/next/test/fail-open.test.ts),
  because "fail-open" as an intention has been shipped as an error page before
- **Batched.** Never a per-request round trip
- **Killable** without a redeploy, and the kill switch itself fails open
- **Loud when it breaks.** A silently failing logger produces a clean-looking
  dataset with holes in it, which is worse than an outage because nobody notices

## Status

**v0.1, early.** Working end to end: the middleware adapter, the classifier,
IP-range verification, file and S3/R2 sinks, the Parquet roll-up, the blind-spots
report and the MCP server. 90 tests.

Next: the Cloudflare Worker adapter (the only route to Shopify), Vector configs,
and publishing to npm.

- **[docs/SETUP.md](docs/SETUP.md)** — install, production storage, first report, troubleshooting
- **[docs/DESIGN.md](docs/DESIGN.md)** — why it is shaped this way: platform reality, the schema, verification, the request-path rules

## Contributing

The most useful contribution is a classifier entry: a new agent is one JSON
object in [`ruleset.json`](packages/core/data/ruleset.json).

```bash
npm install && npm run build && npm test
npm run ranges:update    # refresh published IP ranges
```

MIT.
