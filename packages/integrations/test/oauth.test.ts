import { describe, expect, it } from 'vitest'
import {
  OAUTH_STATE_RE,
  OAuthTokenResponseSchema,
  oauthAuthorizationUrl,
  oauthClassifyTokenError,
  oauthCodeChallengeS256,
  oauthDecodeJwtClaims,
  oauthPkcePair,
  oauthState,
  oauthTokenSetFromResponse,
} from '../src/index.ts'
import { syntheticJwt } from './fixtures/google.ts'

describe('PKCE and state', () => {
  it('matches the RFC 7636 appendix B S256 test vector', async () => {
    expect(await oauthCodeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('creates 256-bit verifiers and states that differ each time', async () => {
    const a = await oauthPkcePair()
    const b = await oauthPkcePair()
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.challenge).toBe(await oauthCodeChallengeS256(a.verifier))
    const s = oauthState()
    expect(s).toMatch(OAUTH_STATE_RE)
    expect(oauthState()).not.toBe(s)
  })

  it('rejects verifiers outside RFC 7636 limits', async () => {
    await expect(oauthCodeChallengeS256('short')).rejects.toThrow('invalid PKCE')
    await expect(oauthCodeChallengeS256('x'.repeat(129))).rejects.toThrow('invalid PKCE')
  })
})

describe('token responses', () => {
  const now = new Date('2026-09-24T10:00:00Z')

  it('accepts numeric or string expires_in and computes an absolute expiry', () => {
    const a = oauthTokenSetFromResponse(
      'google',
      OAuthTokenResponseSchema.parse({ access_token: 'a', expires_in: 3600, token_type: 'Bearer' }),
      now,
    )
    expect(a.accessTokenExpiresAt).toEqual(new Date('2026-09-24T11:00:00Z'))
    expect(a.refreshToken).toBeNull()
    expect(a.grantedScopes).toBeNull()
    const b = oauthTokenSetFromResponse(
      'microsoft',
      OAuthTokenResponseSchema.parse({
        access_token: 'a',
        expires_in: '60',
        scope: 'https://graph.microsoft.com/Mail.Read openid',
        refresh_token: 'r',
      }),
      now,
    )
    expect(b.accessTokenExpiresAt).toEqual(new Date('2026-09-24T10:01:00Z'))
    expect(b.grantedScopes).toEqual(['Mail.Read', 'openid'])
    expect(b.refreshToken).toBe('r')
  })

  it('rejects non-bearer tokens and empty access tokens', () => {
    expect(
      OAuthTokenResponseSchema.safeParse({ access_token: 'a', token_type: 'mac' }).success,
    ).toBe(false)
    expect(OAuthTokenResponseSchema.safeParse({ access_token: '' }).success).toBe(false)
    expect(
      OAuthTokenResponseSchema.safeParse({ access_token: 'a', expires_in: '-1' }).success,
    ).toBe(false)
  })
})

describe('token endpoint error classification', () => {
  const classify = oauthClassifyTokenError('Google', 'token refresh')
  const info = (status: number, code: string | null, retryAfterMs: number | null = null) => ({
    status,
    code,
    reasons: [],
    retryAfterMs,
  })

  it('invalid_grant means reconnect; client problems are configuration', () => {
    expect(classify(info(400, 'invalid_grant'))?.code).toBe('auth.invalid_grant')
    expect(classify(info(400, 'invalid_grant'))?.kind).toBe('auth')
    expect(classify(info(401, 'invalid_client'))?.code).toBe('config.invalid_client')
    expect(classify(info(400, 'unauthorized_client'))?.kind).toBe('config')
    expect(classify(info(400, 'interaction_required'))?.kind).toBe('auth')
    expect(classify(info(400, 'invalid_request'))).toBeUndefined()
  })

  it('429 and 5xx are retryable regardless of body', () => {
    expect(classify(info(429, null, 1000))).toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 1000,
    })
    expect(classify(info(502, 'invalid_grant'))?.kind).toBe('transient')
    expect(classify(info(400, 'temporarily_unavailable'))?.kind).toBe('transient')
  })
})

describe('oauthDecodeJwtClaims', () => {
  it('reads the payload of a well-formed JWT and rejects junk', () => {
    expect(oauthDecodeJwtClaims(syntheticJwt({ sub: 'x', n: 1 }))).toEqual({ sub: 'x', n: 1 })
    expect(oauthDecodeJwtClaims('a.b')).toBeNull()
    expect(oauthDecodeJwtClaims('a.!!!.c')).toBeNull()
    expect(oauthDecodeJwtClaims(`a.${Buffer.from('[1]').toString('base64url')}.c`)).toBeNull()
    expect(oauthDecodeJwtClaims(`a.${Buffer.from('not json').toString('base64url')}.c`)).toBeNull()
  })
})

describe('oauthAuthorizationUrl', () => {
  it('encodes parameters and skips empty ones', () => {
    const url = new URL(
      oauthAuthorizationUrl('https://auth.example.test/authorize', {
        a: 'x y',
        b: undefined,
        c: '',
        redirect_uri: 'https://home.example.test/cb?x=1',
      }),
    )
    expect(url.searchParams.get('a')).toBe('x y')
    expect(url.searchParams.has('b')).toBe(false)
    expect(url.searchParams.has('c')).toBe(false)
    expect(url.searchParams.get('redirect_uri')).toBe('https://home.example.test/cb?x=1')
  })
})
