#!/usr/bin/env node
/**
 * Refreshes packages/core/data/ranges.json from the vendors' published IP-range
 * files — PRD VF-5, CL-5.
 *
 * Run by a scheduled CI job that opens a pull request, so the list does not go
 * stale silently. VF-5: a stale list produces false `unverified`, which reads to
 * a reader as spoofing. Nothing here is ever hand-typed.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, '..', 'packages', 'core', 'data', 'ranges.json')
const doc = JSON.parse(readFileSync(file, 'utf8'))

/** Vendors publish {prefixes:[{ipv4Prefix|ipv6Prefix}]}; normalise to CIDRs. */
function extract(json) {
  const out = []
  const list = Array.isArray(json?.prefixes) ? json.prefixes : []
  for (const p of list) {
    const v = p?.ipv4Prefix ?? p?.ipv6Prefix ?? p?.ipv4 ?? p?.ipv6
    if (typeof v === 'string' && v.includes('/')) out.push(v)
  }
  return out
}

const ranges = {}
const failures = []

for (const source of doc.sources) {
  // One feed can serve several agents: Anthropic publishes a single list for
  // ClaudeBot, Claude-SearchBot and Claude-User.
  const buckets = source.buckets ?? [source.bucket]
  const label = buckets.join(',').padEnd(42)
  try {
    const res = await fetch(source.url, {
      headers: { 'user-agent': 'spoor-ranges-updater (+https://github.com/varunmahajan1/spoor)' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const prefixes = extract(await res.json())
    if (prefixes.length === 0) throw new Error('no prefixes in payload')
    for (const b of buckets) ranges[b] = (ranges[b] ?? []).concat(prefixes)
    console.log(`  ok   ${label} ${prefixes.length} prefixes`)
  } catch (err) {
    failures.push(`${buckets.join(',')}: ${err.message}`)
    console.log(`  FAIL ${label} ${err.message}`)
  }
}

if (Object.keys(ranges).length === 0) {
  console.error('\nNo ranges fetched. Leaving the existing file untouched.')
  console.error('Verification will report `unverified`, which is honest but not useful —')
  console.error('run `spoor doctor` to see this reported as a setup problem rather than a finding.')
  process.exit(1)
}

// Merge rather than replace: a vendor that failed today keeps yesterday's data
// rather than silently losing verification for that crawler.
doc.ranges = { ...doc.ranges, ...ranges }
doc.version = new Date().toISOString().slice(0, 10)
doc.updatedAt = new Date().toISOString()
writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')

const total = Object.values(doc.ranges).reduce((n, a) => n + a.length, 0)
console.log(`\nranges.json → version ${doc.version}, ${total} prefixes across ${Object.keys(doc.ranges).length} buckets`)
if (failures.length) {
  console.log(`${failures.length} source(s) failed and kept their previous data:`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exitCode = 2
}
