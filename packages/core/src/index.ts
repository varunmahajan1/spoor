export type {
  SpoorEvent, SpoorEventExtension, SpoorEventFull,
  CrawlerBucket, CrawlerPurpose, VerifiedBy, Surface, CacheStatus,
} from './schema.js'
export { CORE_FIELDS, isCitationAdjacent, isThrottled, isSuccessfulFetch, AI_CRAWLER_BUCKETS, SEARCH_BUCKETS, isAiCrawler } from './schema.js'

export { classify, CLASSIFIER_VERSION, BUCKETS, NOT_USER_AGENTS } from './classifier.js'
export type { Classification } from './classifier.js'

export { verify, hasRangesFor, rangesArePopulated, RANGES_VERSION, RANGES_UPDATED_AT } from './verify.js'
export type { VerificationInput, VerificationResult } from './verify.js'

export { normalise, normaliseReplayable } from './normalise.js'
export type { NormaliseInput } from './normalise.js'

export { truncateIp, clientIpFromHeaders } from './ip.js'
export { ipInCidr, ipInAnyCidr, isIpv4 } from './cidr.js'
export { newEventId, deterministicEventId } from './event-id.js'
export type { EventIdParts } from './event-id.js'
