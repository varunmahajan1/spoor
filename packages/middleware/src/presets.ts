/**
 * Framework presets — what is not a page fetch.
 *
 * A framework decides how static assets are addressed; the *host* decides where
 * collection happens. So a preset carries two things derived from one list:
 *
 *   `ignore`  — a runtime predicate. Saves storage: an asset never becomes a row.
 *   `matcher` — a route matcher for the host's config. Saves compute: on Vercel
 *               every matched request is a billed invocation, so excluding
 *               assets there is a cost line, not a tidiness preference.
 *
 * Both are generated from the same `paths` array, so they cannot disagree. The
 * alternative — two hand-written lists and a test asserting they match — leaves
 * a real gap: a test proves they agreed at commit time, generation makes
 * disagreement unrepresentable.
 */
import type { Surface } from '@spoor/core'

export type FrameworkPreset = 'next' | 'vite' | 'astro' | 'none'

/**
 * Path prefixes each framework serves build output from.
 *
 * Getting this wrong is not cosmetic. Vite emits hashed bundles to `/assets/`,
 * which the Next.js list does not match, so a Vite site instrumented with the
 * Next preset records every JavaScript and CSS request as a page fetch — and
 * the blind-spots report then reads as full coverage of URLs no crawler asked
 * for.
 */
const FRAMEWORK_PATHS: Record<FrameworkPreset, readonly string[]> = {
  next: ['_next/static/', '_next/image', '__nextjs'],
  vite: ['assets/'],
  astro: ['_astro/'],
  none: [],
}

/**
 * Ignored everywhere. Icons are fetched by browsers and unfurlers, and a
 * favicon request tells you nothing about whether a crawler read your content.
 *
 * Deliberately absent: `robots.txt`, `sitemap.xml`, `llms.txt`. A crawler
 * fetching one of those is among the most informative events in the dataset —
 * it is the crawler telling you what it intends to do next. Never ignore them.
 */
const ALWAYS: readonly string[] = [
  'favicon.ico', 'favicon.png', 'favicon.svg', 'apple-touch-icon',
]

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface Preset {
  readonly name: FrameworkPreset
  /** The prefixes this preset excludes, without leading slashes. */
  readonly paths: readonly string[]
  /** Which surface rows from this adapter are stamped with. */
  readonly surface: Surface
  /** Runtime predicate: true means "do not record this request". */
  readonly ignore: (path: string) => boolean
  /**
   * Route matcher for the host's config, e.g. Vercel's `config.matcher`.
   * Generated from `paths`, so it always excludes exactly what `ignore` does.
   */
  readonly matcher: string[]
}

/**
 * Builds a preset for a framework, optionally stamping a surface.
 *
 * ```ts
 * const site = preset('vite', 'vercel-middleware')
 * const spoor = createRecorder({ sink, ...site })
 * export const config = { matcher: site.matcher }
 * ```
 */
export function preset(name: FrameworkPreset, surface: Surface = 'vercel-middleware'): Preset {
  const paths = [...FRAMEWORK_PATHS[name], ...ALWAYS]
  const alternation = paths.map(escapeRe).join('|')

  return {
    name,
    paths,
    surface,
    ignore: (path: string) => {
      const p = path.startsWith('/') ? path.slice(1) : path
      for (const prefix of paths) if (p.startsWith(prefix)) return true
      return false
    },
    // One capture group, matching everything that is not an ignored prefix.
    // `[]` for the `none` preset would produce `(?!)`, which matches nothing,
    // so an empty list has to fall back to matching every route.
    matcher: [alternation ? `/((?!${alternation}).*)` : '/(.*)'],
  }
}

/** Every preset name, for tests and for `spoor doctor`. */
export const PRESET_NAMES: readonly FrameworkPreset[] = ['next', 'vite', 'astro', 'none']
