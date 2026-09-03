# Changelog

## 0.1.0 — 2026-09-04

First release. Working end to end.

### Added

- **`@spoor/core`** — frozen event schema, versioned classifier, source-side
  verification, IP truncation, event identity. Zero runtime dependencies, and a
  CI job that fails if that changes: it is imported into edge runtimes where
  bundle size and cold start are real.
- **Classification by intent, not vendor.** `GPTBot` (train), `OAI-SearchBot`
  (index) and `ChatGPT-User` (a live user waiting) are three distinct events.
  Same for Anthropic and Perplexity. 36 agents in a JSON ruleset that any
  language can read.
- **Verification against published IP ranges** — about 1000 prefixes across 12
  crawlers, fetched from the operators and never hand-typed. `verified_by`
  records the method, so rows from different surfaces stay comparable.
- **`@spoor/middleware`** — request-path adapter for any fetch-shaped runtime
  (Vercel, Netlify, Deno Deploy, Bun, Node). Non-blocking, fail-open, batched,
  killable, and loud when it breaks. Framework presets (`next`, `vite`, `astro`)
  decide what is build output rather than a page, and generate the host route
  matcher from the same list so the two cannot disagree.
- **`@spoor/sinks`** — file, S3/R2, webhook, memory. The S3 sink signs its own
  requests with SigV4 over Web Crypto rather than carrying an AWS SDK, and R2
  speaks the S3 API so one implementation covers both.
- **`spoor` CLI** — `demo`, `doctor`, `rollup`, `report`, `query`. DuckDB writes
  the Parquet and answers the queries; remote S3/R2 stores are read in place.
- **`@spoor/mcp`** — six tools over the event store, so a coding agent can ask
  it questions directly. Read-only.
- **Blind-spots report** — published URLs no answer engine has fetched. Excludes
  Googlebot and Bingbot by default, because a search crawl is not evidence an
  answer engine saw the page.
- 90 tests. A scheduled job refreshes the IP ranges and opens a pull request.

### Notes

- The adapter never imported Next.js — it was typed against `Request`/`Response`
  from the start — so naming it after a framework was wrong, and naming it after
  a host would have been the same mistake one level up. It is `@spoor/middleware`
  because what varies is the framework's asset paths and the host's collection
  point, not the code.
- `cache_status` is `unknown` on every host-middleware surface. Middleware runs
  before the cache, so at record time the status does not exist; `x-vercel-cache`
  is a response header. Recording `unknown` is honest, not missing.

### Known limitations

- Not published to npm; install from source.
- Cloudflare Worker adapter not built, so **standard Shopify is not yet
  supported** — that is the only route to it.
- Vector configs and the WordPress plugin are not built.
- Reverse-DNS verification is specified but not implemented; verification is by
  IP range only.
