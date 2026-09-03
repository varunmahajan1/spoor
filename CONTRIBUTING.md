# Contributing

## Adding a crawler

This is the most useful contribution, and it is one JSON object in
[`packages/core/data/ruleset.json`](packages/core/data/ruleset.json):

```json
{ "name": "SomeBot", "bucket": "other-bot", "purpose": "index",
  "vendor": "someone", "match": ["somebot"] }
```

Three rules:

1. **Order matters.** Matching is first-hit, so a more specific agent must come
   before a less specific one — `Claude-SearchBot` before `ClaudeBot`.
2. **Never guess `purpose`.** If the vendor does not document what the crawler
   does, it is `unknown`. A wrong purpose is worse than no purpose, because the
   reports group by it.
3. **`bucket` must already exist.** The bucket list is frozen — it is a column
   in stored Parquet. A new agent that does not fit gets `other-bot`, and the
   raw user agent is retained so it can be reclassified later.

Then `npm run build && npm test`.

## Adding IP ranges

Don't — not by hand. Add the vendor's published URL to the `sources` array in
[`ranges.json`](packages/core/data/ranges.json) and run `npm run ranges:update`.
A hand-typed range is a security-relevant claim nobody can verify in review.

## Adding an adapter

An adapter's only job is to produce `SpoorEvent`s via `normalise()` from
`@spoor/core` and hand them to a sink. It must not classify or verify itself —
that is what keeps every surface comparable.

If it runs on a request path, it must:

- never block the response (`waitUntil` or equivalent)
- never throw into the caller, and ship a test proving it
- batch, rather than round-trip per request
- report its own errors, so a failure is visible instead of producing a
  clean-looking dataset with holes in it

## Core has no dependencies

`@spoor/core` is imported into Cloudflare Workers and Next.js middleware. CI
fails if it gains a runtime dependency. If you need one, it belongs elsewhere.
