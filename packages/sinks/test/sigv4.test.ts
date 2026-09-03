import { describe, expect, it } from 'vitest'
import { sha256Hex, encodeKey, signingKey, toHex, signRequest } from '../src/sigv4.js'

describe('SigV4 primitives, against published values', () => {
  it('computes SHA-256 correctly', () => {
    return Promise.all([
      expect(sha256Hex('')).resolves.toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
      expect(sha256Hex('abc')).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'),
    ])
  })

  it('derives the signing key matching AWS’s published example', async () => {
    // From AWS's "Examples of how to derive a signing key" documentation.
    // A wrong chain here yields a 403 with no useful diagnostic, so it is
    // checked against the vendor's own value rather than against itself.
    const key = await signingKey(
      'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam',
    )
    expect(toHex(key)).toBe('f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d')
  })
})

describe('S3 key encoding', () => {
  it('encodes each segment but preserves the path separator', () => {
    expect(encodeKey('/events/2026-09-04/abc.ndjson')).toBe('/events/2026-09-04/abc.ndjson')
    expect(encodeKey('/a b/c')).toBe('/a%20b/c')
    expect(encodeKey("/it's")).toBe('/it%27s')
    expect(encodeKey('/a+b')).toBe('/a%2Bb')
  })
})

describe('signRequest', () => {
  const creds = {
    region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    now: new Date('2026-09-04T00:00:00.000Z'),
  }
  const url = new URL('https://examplebucket.s3.us-east-1.amazonaws.com/events/2026-09-04/x.ndjson')

  it('emits the headers S3 requires', async () => {
    const h = await signRequest({ method: 'PUT', url, body: 'line\n', ...creds })
    expect(h['x-amz-date']).toBe('20260904T000000Z')
    expect(h['x-amz-content-sha256']).toBe(await sha256Hex('line\n'))
    expect(h['host']).toBe('examplebucket.s3.us-east-1.amazonaws.com')
    expect(h['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260904\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    )
  })

  it('is deterministic for identical inputs', async () => {
    const a = await signRequest({ method: 'PUT', url, body: 'x', ...creds })
    const b = await signRequest({ method: 'PUT', url, body: 'x', ...creds })
    expect(a['authorization']).toBe(b['authorization'])
  })

  it('changes the signature when anything signed changes', async () => {
    const base = await signRequest({ method: 'PUT', url, body: 'x', ...creds })
    const variants = await Promise.all([
      signRequest({ method: 'PUT', url, body: 'y', ...creds }),
      signRequest({ method: 'GET', url, body: 'x', ...creds }),
      signRequest({ method: 'PUT', url: new URL('https://examplebucket.s3.us-east-1.amazonaws.com/other'), body: 'x', ...creds }),
      signRequest({ method: 'PUT', url, body: 'x', ...creds, now: new Date('2026-09-05T00:00:00.000Z') }),
      signRequest({ method: 'PUT', url, body: 'x', ...creds, secretAccessKey: 'different' }),
    ])
    for (const v of variants) expect(v['authorization']).not.toBe(base['authorization'])
  })

  it('includes a session token in the signed headers when present', async () => {
    const h = await signRequest({ method: 'PUT', url, body: 'x', ...creds, sessionToken: 'TOKEN' })
    expect(h['x-amz-security-token']).toBe('TOKEN')
    expect(h['authorization']).toContain('x-amz-security-token')
  })
})
