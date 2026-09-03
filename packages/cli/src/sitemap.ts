/**
 * Reads the set of URLs a site publishes, so Report 3 can ask which of them no
 * crawler ever reached. Follows sitemap indexes one level.
 *
 * Deliberately a small regex reader rather than an XML parser dependency: a
 * sitemap is a flat list of <loc> elements and this keeps the CLI's dependency
 * surface to DuckDB alone.
 */
export interface SitemapResult { paths: string[]; urls: string[]; fetched: string[] }

const LOC = /<loc>\s*([^<\s]+)\s*<\/loc>/gi

async function get(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'spoor (+https://github.com/varunmahajan1/spoor)' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`${url} responded ${res.status}`)
  return res.text()
}

export async function readSitemap(url: string, depth = 1): Promise<SitemapResult> {
  const body = await get(url)
  const locs = [...body.matchAll(LOC)].map((m) => m[1]!)
  const isIndex = /<sitemapindex/i.test(body)
  const fetched = [url]
  let urls: string[] = []

  if (isIndex && depth > 0) {
    for (const child of locs) {
      try {
        const nested = await readSitemap(child, depth - 1)
        urls.push(...nested.urls)
        fetched.push(...nested.fetched)
      } catch {
        // A broken child sitemap should not lose the rest of the index.
      }
    }
  } else {
    urls = locs
  }

  const paths = [...new Set(urls.map((u) => {
    try { return new URL(u).pathname } catch { return null }
  }).filter((p): p is string => p !== null))].sort()

  return { paths, urls, fetched }
}
