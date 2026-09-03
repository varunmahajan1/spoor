/**
 * The versioned classifier — PRD §8.3, CL-1 to CL-5.
 *
 * The ruleset is data (data/ruleset.json), not code, so an adapter written in a
 * language this package does not target reads the same source of truth (AR-6).
 * This file is only the evaluator.
 */
import { RULESET } from './data.generated.js'
import type { CrawlerBucket, CrawlerPurpose } from './schema.js'

export interface Classification {
  bucket: CrawlerBucket
  purpose: CrawlerPurpose
  /** The ruleset's own name for the agent. Diagnostic only — not a schema
   *  field, because §8.1 is frozen and `user_agent` is retained raw. */
  agent: string | null
  vendor: string | null
  version: string
}

export const CLASSIFIER_VERSION: string = RULESET.version

const HUMAN: Omit<Classification, 'version'> = {
  bucket: 'human', purpose: 'unknown', agent: null, vendor: null,
}

/**
 * Classifies a raw User-Agent string.
 *
 * Matching is case-insensitive substring, first match wins, so ruleset order is
 * significant — `oai-searchbot` must precede `gptbot`-style generic entries.
 * The ruleset is ordered most-specific-first and the test suite asserts that
 * the agents which are commonly conflated stay separated (DF-1).
 */
export function classify(userAgent: string | null | undefined): Classification {
  const version = RULESET.version
  if (!userAgent) return { ...HUMAN, version }

  const ua = userAgent.toLowerCase()

  for (const agent of RULESET.agents) {
    for (const needle of agent.match) {
      if (ua.includes(needle)) {
        return {
          bucket: agent.bucket as CrawlerBucket,
          purpose: agent.purpose as CrawlerPurpose,
          agent: agent.name,
          vendor: agent.vendor,
          version,
        }
      }
    }
  }

  // Unrecognised but bot-shaped. CL-4: purpose is `unknown`, never guessed.
  for (const hint of RULESET.genericBotHints) {
    if (ua.includes(hint)) {
      return { bucket: 'other-bot', purpose: 'unknown', agent: null, vendor: null, version }
    }
  }

  return { ...HUMAN, version }
}

/**
 * PRD §8.3: `google-extended` and `applebot-extended` are robots.txt opt-out
 * tokens, not user agents. No request ever arrives carrying them, so as buckets
 * they would be permanently zero. Exported so the test suite can assert they
 * never enter the bucket space.
 */
export const NOT_USER_AGENTS: readonly string[] = RULESET.notAUserAgent

/** Every bucket the frozen schema allows. */
export const BUCKETS: readonly string[] = RULESET.buckets
