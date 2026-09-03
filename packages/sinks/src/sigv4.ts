/**
 * Minimal AWS SigV4 request signing, using only Web Crypto.
 *
 * This exists instead of an SDK dependency because the sink it serves runs in
 * Cloudflare Workers and Next.js middleware, where bundle size and cold start
 * are real. `@aws-sdk/client-s3` is several hundred kilobytes to put an object;
 * this is the part of it that is actually needed.
 *
 * Scope is deliberately narrow: single-shot PUT of a small body, SHA-256 payload
 * hashing, no chunked uploads and no multipart. That is all a log batch needs.
 */

const enc = new TextEncoder()

/** Key material accepted by SubtleCrypto, without pulling in DOM lib types. */
type KeyMaterial = Parameters<typeof crypto.subtle.importKey>[1]

async function hmac(key: KeyMaterial, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', k, enc.encode(data))
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(data)))
}

/** S3 keys are path segments: encode everything except unreserved chars and `/`. */
export function encodeKey(key: string): string {
  return key.split('/').map((seg) =>
    encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
  ).join('/')
}

/**
 * The SigV4 signing-key derivation chain, exported so it can be checked against
 * AWS's published test vector. This is the part most likely to be subtly wrong,
 * and a wrong signing key produces a 403 with no useful diagnostic.
 */
export async function signingKey(
  secretAccessKey: string, dateStamp: string, region: string, service: string,
): Promise<ArrayBuffer> {
  let key: KeyMaterial = enc.encode(`AWS4${secretAccessKey}`)
  for (const part of [dateStamp, region, service, 'aws4_request']) key = await hmac(key, part)
  return key as ArrayBuffer
}

export function toHex(buf: ArrayBuffer): string { return hex(buf) }

export interface SignOptions {
  method: string
  url: URL
  body: string
  region: string
  service?: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string | undefined
  now?: Date
}

/** Returns the headers a signed request must carry. */
export async function signRequest(o: SignOptions): Promise<Record<string, string>> {
  const service = o.service ?? 's3'
  const now = o.now ?? new Date()
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = await sha256Hex(o.body)

  const headers: Record<string, string> = {
    host: o.url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  }
  if (o.sessionToken) headers['x-amz-security-token'] = o.sessionToken

  const signedHeaders = Object.keys(headers).sort()
  const canonicalHeaders = signedHeaders.map((h) => `${h}:${headers[h]!.trim()}\n`).join('')
  const signedHeaderList = signedHeaders.join(';')

  const canonicalRequest = [
    o.method,
    encodeKey(o.url.pathname),
    o.url.searchParams.toString(),
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/${o.region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n')

  const signature = hex(await hmac(
    await signingKey(o.secretAccessKey, dateStamp, o.region, service), stringToSign,
  ))

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaderList}, Signature=${signature}`,
  }
}
