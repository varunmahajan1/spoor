/**
 * Source-side crawler verification — PRD §9, VF-2 to VF-7.
 *
 * VF-1 was withdrawn in PRD v3. `request.cf.botManagement.verifiedBot` is an
 * Enterprise-plan Bot Management field, so the "verification is free at the
 * edge" argument that made the Worker the primary surface does not hold on the
 * plans people actually run. Verification is therefore by bundled range list on
 * *every* surface, implemented once here (VF-6), and the Cloudflare signal is
 * used opportunistically where it happens to be present (VF-7).
 *
 * The value of recording `verified_by` is precisely that these differ.
 */
import { RANGES } from './data.generated.js'
import { ipInAnyCidr } from './cidr.js'
import type { CrawlerBucket, VerifiedBy } from './schema.js'

export interface VerificationInput {
  bucket: CrawlerBucket
  /** The full address. Never stored — used here and discarded (LG-2). */
  ip?: string | null
  /** Cloudflare's own signal, where the zone is entitled to it (VF-7). */
  cfVerifiedBot?: boolean | undefined
}

export interface VerificationResult {
  verified: boolean
  by: VerifiedBy
}

const UNVERIFIED: VerificationResult = { verified: false, by: 'unverified' }

/** True when the bundled list actually carries prefixes for this bucket. */
export function hasRangesFor(bucket: CrawlerBucket): boolean {
  return (RANGES.ranges[bucket]?.length ?? 0) > 0
}

/** Whether any range data at all has been fetched. False on a fresh install. */
export function rangesArePopulated(): boolean {
  return RANGES.version !== '0' && Object.keys(RANGES.ranges).length > 0
}

/**
 * Verifies a claimed crawler identity.
 *
 * Returns `unverified` — never a guess — when there is no range data for the
 * bucket. VF-5 warns that a stale or absent list produces false `unverified`,
 * which reads to a reader as spoofing, so `spoor doctor` surfaces an unpopulated
 * list as a setup problem rather than letting it look like a finding.
 */
export function verify(input: VerificationInput): VerificationResult {
  const { bucket, ip, cfVerifiedBot } = input

  if (bucket === 'human') return UNVERIFIED

  // VF-7: opportunistic, never assumed.
  if (cfVerifiedBot === true) return { verified: true, by: 'cf_verified_bot' }

  if (!ip) return UNVERIFIED
  const cidrs = RANGES.ranges[bucket]
  if (!cidrs || cidrs.length === 0) return UNVERIFIED

  return ipInAnyCidr(ip, cidrs)
    ? { verified: true, by: 'ip_range' }
    : UNVERIFIED
}

export const RANGES_VERSION: string = RANGES.version
export const RANGES_UPDATED_AT: string | null = RANGES.updatedAt
