# Design notes

Why spoor is shaped the way it is. The decisions here were expensive to reach
and most of them are not obvious from the code.

---

## 1. What this collects, and why nothing else does

AI crawlers do not execute JavaScript. That single fact determines everything:

- **Google Analytics never sees them.** GA4 is a client-side beacon; no JS, no
  hit. This is not a sampling problem, it is a total blind spot.
- **Search Console does not report them.** It reports Googlebot, not GPTBot.
- **Shopify Analytics cannot see them.** Online store sessions are
  session-based, so they are blind to non-JS clients by construction.

Server-side request data is the only source. That is the whole reason this tool
exists — not because logs are interesting, but because for this question they
are the only evidence there is.

**What spoor is not.** Vector, Fluent Bit and the OpenTelemetry Collector own
generic log shipping and do it better than this will. If you want logs in S3,
use one of those. spoor has wide coverage and a narrow purpose; invert those two
and it has no reason to exist.

## 2. Platform reality

Collection is not universally possible, and the shape of the impossibility
differs per platform. This is the constraint that shapes the product, so it is
stated before anything else.

| Platform | Route | Kind |
|---|---|---|
| Next.js / Vercel | Application middleware | Push |
| Any site on Cloudflare | Worker at the edge | Push |
| Standard Shopify | Cloudflare in front, via O2O | Push |
| WooCommerce / WordPress | Host access logs, or a PHP mu-plugin | Logs / push |
| Magento / Adobe Commerce | nginx or Apache access logs | Logs |
| Self-hosted, any stack | Access logs via Vector | Logs |
| Vercel (Pro/Enterprise) | Log drain | Drain |
| Shopify on Hydrogen/Oxygen | Oxygen log drains | Drain |
| Standard Shopify **without DNS control** | None | — |

**Drains and push are not the same ask.** In a drain, the platform ships data to
you and your obligation is one config screen. In push, *your code runs on your
own request path*. That is a categorically larger commitment, and it is the
entire reason §6 exists. Only two of the routes above are drains.

Every fact in this section was read on **2026-09-03** against primary vendor
documentation. Plan gates and eligibility move; re-read before relying on them.

### 2.1 Standard Shopify has no first-party route

Confirmed, and not for want of looking:

- **Apps** run in the admin. They receive webhooks and Admin API data, never
  storefront HTTP requests.
- **Web pixels and theme JavaScript** are client-side, and AI crawlers do not
  run JavaScript. They capture none of the target traffic.
- **Liquid** renders server-side but cannot make outbound requests and cannot
  see the requester's user agent. The `request` object exposes host, path,
  page_type, locale, origin and design_mode only. (The `user_agent` Liquid
  object is the User-agent *directive* inside `robots.txt.liquid` — unrelated,
  and a common source of confusion.)
- **App proxy** does expose a server-side request with full headers, but only
  for its own path. Crawlers hitting product pages never touch it.
- **The admin has no AI crawler report.**

No app, theme or plugin resolves this. The data does not leave Shopify's edge by
any first-party route.

### 2.2 The Cloudflare route, and its caveat

The only route is putting a Cloudflare zone in front of the storefront, using
[Orange-to-Orange routing][o2o], where a proxied CNAME points at another
Cloudflare customer. Cloudflare documents this officially for Shopify:

- Works on **any Cloudflare zone plan, including Free**
- **Workers run on the request path.** Documented limitation: Workers and
  Snippets are disabled on the `/checkout` URI path
- The documented failure mode is specific and avoidable: **do not enable
  "Always Use HTTPS"** — it redirects `/.well-known/acme-challenge/*` and breaks
  certificate provisioning and renewal. Cloudflare's fix is a redirect rule that
  excludes that path

**The `/checkout` carve-out costs this tool nothing.** AI crawlers never request
checkout. The one limitation that would kill a checkout-analytics product is
irrelevant here.

**And the caveat that matters:** [Shopify's position][shopify-domains] is that
Cloudflare proxy setups, *including O2O*, are not supported and "could break at
any time." Cloudflare documents it; Shopify disclaims it. That is a real
tradeoff on a revenue-bearing storefront and it belongs to whoever runs the
store, stated before the install steps rather than after them.

spoor will not document a workaround for the `/checkout` limitation. PCI scope
is not ours to reason about.

### 2.3 Cloudflare's AI-block default can suppress the traffic you are measuring

If you move DNS to Cloudflare in order to install spoor, and accept the default
in Cloudflare's "manage AI bot traffic" feature, **the AI crawler traffic you
are trying to measure can stop arriving — because you installed spoor.**

That is the failure that would discredit the tool, so the Worker adapter's
preflight will verify the setting and refuse to report until it passes, rather
than leaving it as a checklist item somebody skips. A site whose AI bots are
blocked must be reported as **blocked**, never as zero traffic.

### 2.4 Shopify Web Bot Auth: a third kind of zero

Since **30 May 2026**, [Shopify rate-limits bots that do not sign their
requests][webbotauth] with Web Bot Auth, on both the Storefront API and
Shopify-hosted storefront pages. Changes to `robots.txt` do not bypass it.

So a page with no crawler traffic is one of three findings, with three different
owners:

| Zero | Meaning | Whose problem |
|---|---|---|
| **blocked** | `robots.txt` or the CDN said no | Configuration |
| **throttled** | The platform rate-limited the crawler (429) | The platform |
| **never crawled** | Nobody came | Content or discoverability |

Any report that shows one number for all three is wrong, and wrong in the
direction that looks like a content problem. `status` is in the schema for
exactly this, and the reports separate 429s from 2xx everywhere.

[o2o]: https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/provider-guides/shopify/
[shopify-domains]: https://help.shopify.com/en/manual/domains/troubleshoot-issues-with-domains
[webbotauth]: https://shopify.dev/changelog/bots-and-agents-should-identify-themselves-via-web-bot-auth

## 3. Architecture

```
  sources (plugins)  ─┐
                      ├─→  core: schema + versioned classifier + verification  ─┬─→  sinks (plugins)
  ingest API  ────────┘                                                         └─→  MCP server (query)
```

- **Core is the schema, the classifier and the normaliser.** Everything else is
  a plugin. Core is the only thing that must not fork.
- **Sources and sinks are independent.** No source knows about any sink.
- **A sink is the operator's choice**, and the default is a local file, so the
  tool is useful with zero infrastructure. If a quickstart needs an account, the
  tool has failed.
- **R2 speaks the S3 API**, so one S3 sink implementation covers both.
- **The classifier is a language-neutral data file**, so an adapter written in a
  language core does not target still shares one source of truth.

### MCP is a query layer, not a source

Worth splitting, because one half of the idea is strong and the other is empty.

**MCP as a source does not work and is not built.** No platform exposes
storefront request logs over MCP; it would be a plugin interface with no
implementations.

**MCP as a query layer over collected logs** means any coding agent can ask
"which product URLs has GPTBot never fetched?" against real data. It costs
little on top of the DuckDB layer the reports need anyway, so it is in v0.1
rather than the backlog.

## 4. The schema

Field names are frozen. They are columns in stored Parquet, so renaming one
invalidates history.

| Field | Why it is there |
|---|---|
| `event_id` | UUIDv7, or a content hash. **The dedupe key** — see §7 |
| `ts` | ISO 8601, UTC |
| `host` | Multi-domain, locale subdomains and staging otherwise collapse into `path` |
| `method`, `path` | Path only, no query string |
| `query` | Null unless you opt in. **The column exists regardless** — Parquet dictionary-encodes it, so a null column is near-free, and this avoids a schema change the first time faceted navigation matters |
| `status` | A 429 is a throttle, not a crawl (§2.4) |
| `bytes`, `duration_ms` | Where the surface provides them |
| `cache_status` | A response served from cache without invoking the logger is an unlogged visit. This makes the blind spot a per-row fact rather than a suspicion |
| `user_agent` | Raw. **The source of truth** — every derived field below is re-derivable from it, which is what makes reclassification possible |
| `crawler_bucket` | Derived, **specific agent, not vendor** — see §5 |
| `crawler_purpose` | Derived: `train`, `index`, `user_fetch`, `preview`, `unknown`. **The field the reports group by** |
| `crawler_verified` | Set at source |
| `verified_by` | *How* verification was established. Without this, a verified row from one surface and one from another are not comparable |
| `classifier_version` | Which ruleset produced the derived fields. Enables re-derivation over history |
| `referer` | |
| `ip_prefix` | Truncated at source. Preserves range membership so a corrected list can be re-applied |
| `surface` | Which adapter produced the row |

## 5. Classification: intent, not vendor

**Two errors that most bot lists make, both consequential.**

**One: `Google-Extended` and `Applebot-Extended` are not user agents.** They are
`robots.txt` opt-out tokens. No request ever arrives carrying them, so as
buckets they would be permanently zero columns. There is a test asserting they
never enter the bucket space.

**Two: bucketing by vendor throws away the most interesting signal you have.**
OpenAI sends three distinct crawlers:

| Agent | Purpose | What it means |
|---|---|---|
| `GPTBot` | `train` | Building a training corpus |
| `OAI-SearchBot` | `index` | Building a search index |
| `ChatGPT-User` | `user_fetch` | **A live user is waiting on this answer right now** |

Anthropic sends ClaudeBot, Claude-SearchBot and Claude-User. Perplexity sends
PerplexityBot and Perplexity-User. Every list surveyed collapses these into
"OpenAI" and "Anthropic".

**A `user_fetch` is the closest thing in your logs to a citation event** — the
model retrieving the page to answer somebody, at that moment. The gap between an
`index` crawl and a `user_fetch` is a measure of how long it took your content
to become answerable. Collapse the two and that measurement is gone.

Rules the classifier follows:

- The ruleset is **versioned data in the repo**, not a constant in each adapter
- Derived values are written at source with the pinned version, **and are
  re-derivable at query time** from the raw user agent
- New agents ship constantly. A crawler that did not exist in month one must not
  stay `other-bot` in that partition forever — an unreclassifiable history is a
  longitudinal series that is wrong while looking fine
- **An unclassified agent's purpose is `unknown`, never guessed from the
  vendor.** A wrong purpose is worse than no purpose, because reports group by it

## 6. Verification

### The finding that reshaped this

An earlier design took verification from Cloudflare:
`request.cf.botManagement.verifiedBot` is computed at the edge, so no DNS round
trip, no IP retained, no ruleset to maintain. That was the strongest argument
for making the Worker the primary adapter.

**It does not hold.** [`cf.bot_management.verified_bot`][cfbot] is an
**Enterprise-plan Bot Management field**. Free plans get Bot Fight Mode; Pro and
Business get Super Bot Fight Mode. Neither populates `request.cf.botManagement`
in a Worker.

Consequences, all of them structural:

- The Worker has no verification advantage, so **middleware is the reference
  adapter** — it needs no DNS change, no account and no third party
- **Every surface needs the bundled range list**, so it lives in core rather
  than per-adapter, where three copies would be three drift surfaces
- The Cloudflare signal is used **opportunistically where present**, never
  assumed. `verified_by` records which happened, which is precisely why that
  field exists

[cfbot]: https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/cf.bot_management.verified_bot/

### How it works now

- **Published IP ranges**, fetched from each operator, checked at source
- **Reverse DNS is sampled and asynchronous, never per request.** A DNS round
  trip on a request path fights the non-blocking requirement directly
- **`ip_prefix` is retained** so a corrected range list can be re-applied to
  history. This is the thing a source-only verification cannot do
- **The list is refreshed on a schedule.** A stale list produces false
  `unverified`, which reads to someone looking at a report as spoofing rather
  than as a maintenance lapse. `spoor doctor` reports an unpopulated list as a
  setup problem so it never looks like a finding

**Never hand-type a range.** It is a security-relevant claim nobody can verify in
review. Add the vendor's URL to `sources` and run the updater.

One nuance the data forces: some vendors publish **one combined feed for several
agents** — Anthropic does. So a range match proves the *operator*, not the
specific agent. The user agent supplies the agent; the range supplies the proof
that the claim came from the operator's infrastructure.

## 7. Pipeline

```
adapter → batched write → append-only NDJSON, partitioned by date
        → roll-up to Parquet, deduped on event_id
        → DuckDB for analysis; queries live in the repo
        → MCP server over the same store
```

**Deduplication is not optional.** Batches retry — they must, because a
fail-open adapter drops and the collector retries — so the store *will* contain
duplicates. Without a dedupe key you get "no gaps" but not "no double-counting",
and **a duplicated batch inflates the crawl count, which is the number being
reported.** The store view deduplicates on `event_id`, so every report is
correct even before a roll-up has run.

Event identity differs by surface, and the difference matters:

- **Push surfaces** (middleware, Worker) emit once per request. A random,
  time-ordered UUIDv7 is correct: a retried *batch* carries the same ids.
- **Log-derived surfaces** (Vector, a drain receiver) can re-ship the same line
  from a restarted process with no memory of the first attempt. A random id
  would mint a fresh identity for an event already stored. Those surfaces use a
  content hash, so identity is a property of the event rather than of the emit.

The roll-up writes a **new generation** rather than mutating one, so re-running
it with a newer classifier version is safe and reversible.

## 8. On the request path

The adapters run in front of real traffic — and in an open-source tool, in front
of *strangers'* traffic. That raises the bar, so these are requirements rather
than intentions:

| | |
|---|---|
| **Non-blocking** | Logging goes through `waitUntil`; the visitor never waits |
| **Fail-open** | A sink that is down drops a batch, it does not fail a request. In a Cloudflare Worker this means `ctx.passThroughOnException()` — naming the mechanism is the requirement, because "fail-open" as an intention has shipped as a 1101 error page more than once |
| **Batched** | Never a per-request round trip |
| **Killable** | Without a redeploy. This fights non-blocking unless specified: the check is cached in the isolate behind a short TTL, and **the check itself fails open.** A kill switch that can hang the request path is a worse outage than the one it exists to stop |
| **Loud** | A silently failing fail-open surface produces a clean-looking dataset with holes in it, which is worse than an outage because nobody notices |

Every adapter ships a test asserting the response survives a thrown logger. That
is the one failure that would do real damage, so it gets an automated test
rather than a review.

## 9. Privacy

**The full IP never leaves your infrastructure.** It is truncated at the point of
collection — /24 for IPv4, /48 for IPv6 — used for range verification, then
discarded. Human rows are dropped at source by default: smaller storage, and no
report here needs them.

**These rows are pseudonymised, not anonymous, and the difference is not
rhetorical.** A /24 prefix is identifying in a small population. A salted hash of
an IPv4 address is not anonymous either — the v4 space is small enough to
brute-force an entire table against a known salt. Retaining a prefix is the
accepted cost of being able to re-verify history against a corrected range list.

If you are writing a privacy notice, do not describe these rows as anonymous.
This is a tool, not legal advice.

## 10. Open questions

1. **Retention default** — long enough for longitudinal work, short enough to
   defend.
2. **Query string handling** — the column always exists; the open question is
   the default for populating it.
3. **Does spoor ship a robots.txt checker, or only consume one?** Telling the
   three zeros apart (§2.4) needs robots.txt state, and that is a different kind
   of data collection from everything else here.
4. **How much of the ingest API belongs in v0.1?** An adapter writing directly
   to a sink needs no ingest API at all.
5. **Is the WordPress adapter worth its cost?** It shares no code with core and
   doubles the language surface. Demand-gated.
