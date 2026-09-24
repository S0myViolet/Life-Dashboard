// Tests use SYNTHETIC FIXTURES (not captured from the live service): see fixtures/google.ts.
import { describe, expect, it } from 'vitest'
import { isConnectionError, type ConnectionFailure } from '@personal-home/core'
import { GOOGLE_ENDPOINTS, createGoogleAdapter } from '../src/index.ts'
import {
  createFakeFetch,
  formBody,
  jsonResponse,
  textResponse,
  type FakeHandler,
} from './fixtures/fake-fetch.ts'
import {
  GOOGLE_CALENDAR_ONLY_GRANTED,
  GOOGLE_EMAIL,
  GOOGLE_SUB,
  GOOGLE_TEST_CLIENT,
  gmailProfile,
  googleApiDisabled,
  googleCalendarList,
  googleExchangeResponse,
  googleIdToken,
  googleInsufficientScope,
  googleInvalidClient,
  googleInvalidGrant,
  googleRefreshResponse,
  googleTooManyRequests,
  googleUnauthenticated,
  googleUnavailable,
  googleUserRateLimit,
  googleUserinfo,
} from './fixtures/google.ts'

const now = new Date('2026-09-24T10:00:00Z')
const adapter = createGoogleAdapter(GOOGLE_TEST_CLIENT)
const REDIRECT = 'https://home.example.test/api/connections/google/callback'

function ctx(handler: FakeHandler) {
  const fake = createFakeFetch(handler)
  return { ctx: { fetch: fake.fetch, now: () => now }, calls: fake.calls }
}

async function failureOf(p: Promise<unknown>): Promise<ConnectionFailure> {
  try {
    await p
  } catch (err) {
    if (isConnectionError(err)) return err.failure
    throw err
  }
  throw new Error('expected a ConnectionError')
}

describe('Google authorization URL', () => {
  it('requests read-only scopes, offline access, forced consent, PKCE S256 and state', () => {
    const url = new URL(
      adapter.authorize({
        state: 'S'.repeat(43),
        codeChallenge: 'C'.repeat(43),
        redirectUri: REDIRECT,
      }),
    )
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_ENDPOINTS.authorize)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: GOOGLE_TEST_CLIENT.clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope:
        'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.readonly',
      access_type: 'offline',
      prompt: 'consent select_account',
      include_granted_scopes: 'true',
      state: 'S'.repeat(43),
      code_challenge: 'C'.repeat(43),
      code_challenge_method: 'S256',
    })
    expect(url.searchParams.has('client_secret')).toBe(false)
  })

  it('adds a login hint when reconnecting a known account', () => {
    const url = new URL(
      adapter.authorize({
        state: 's',
        codeChallenge: 'c',
        redirectUri: REDIRECT,
        loginHint: GOOGLE_EMAIL,
      }),
    )
    expect(url.searchParams.get('login_hint')).toBe(GOOGLE_EMAIL)
  })
})

describe('Google code exchange and refresh', () => {
  it('exchanges the code with the verifier and client secret, and normalises granted scopes', async () => {
    const { ctx: c, calls } = ctx(() => jsonResponse(googleExchangeResponse(now)))
    const tokens = await adapter.exchange(
      { code: '4/0Asynthetic-code', codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT },
      c,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe(GOOGLE_ENDPOINTS.token)
    expect(calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(formBody(calls[0]!)).toEqual({
      code: '4/0Asynthetic-code',
      client_id: GOOGLE_TEST_CLIENT.clientId,
      client_secret: GOOGLE_TEST_CLIENT.clientSecret,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
      code_verifier: 'v'.repeat(43),
    })
    expect(tokens.accessToken).toBe('ya29.synthetic-access-token-1')
    expect(tokens.refreshToken).toBe('1//synthetic-refresh-token-1')
    expect(tokens.accessTokenExpiresAt).toEqual(new Date(now.getTime() + 3599_000))
    expect(tokens.grantedScopes).toEqual([
      'openid',
      'email',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ])
  })

  it('records a partial (granular consent) grant honestly', async () => {
    const { ctx: c } = ctx(() =>
      jsonResponse(googleExchangeResponse(now, GOOGLE_CALENDAR_ONLY_GRANTED)),
    )
    const tokens = await adapter.exchange(
      { code: 'c', codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT },
      c,
    )
    expect(tokens.grantedScopes).not.toContain('https://www.googleapis.com/auth/gmail.readonly')
    expect(tokens.grantedScopes).toContain(
      'https://www.googleapis.com/auth/calendar.events.readonly',
    )
  })

  it('refreshes; Google does not rotate the refresh token', async () => {
    const { ctx: c, calls } = ctx(() => jsonResponse(googleRefreshResponse))
    const tokens = await adapter.refresh('1//synthetic-refresh-token-1', c)
    expect(formBody(calls[0]!)).toEqual({
      client_id: GOOGLE_TEST_CLIENT.clientId,
      client_secret: GOOGLE_TEST_CLIENT.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: '1//synthetic-refresh-token-1',
    })
    expect(tokens.accessToken).toBe('ya29.synthetic-access-token-2')
    expect(tokens.refreshToken).toBeNull()
  })

  it('invalid_grant → auth failure (needs reconnect) without leaking the token or secret', async () => {
    const { ctx: c } = ctx(() => jsonResponse(googleInvalidGrant, 400))
    const f = await failureOf(adapter.refresh('1//synthetic-refresh-token-1', c))
    expect(f).toMatchObject({ kind: 'auth', code: 'auth.invalid_grant', httpStatus: 400 })
    expect(f.message).not.toContain('synthetic-refresh')
    expect(f.message).not.toContain(GOOGLE_TEST_CLIENT.clientSecret)
    expect(f.message).not.toContain('expired or revoked')
  })

  it('invalid_client → configuration failure', async () => {
    const { ctx: c } = ctx(() => jsonResponse(googleInvalidClient, 401))
    expect(await failureOf(adapter.refresh('r', c))).toMatchObject({
      kind: 'config',
      code: 'config.invalid_client',
    })
  })

  it('token endpoint 429 with Retry-After, 5xx and malformed JSON', async () => {
    const a = ctx(() => jsonResponse({ error: 'rate_limit' }, 429, { 'retry-after': '45' }))
    expect(await failureOf(adapter.refresh('r', a.ctx))).toMatchObject({
      kind: 'rate_limited',
      retryAfterMs: 45_000,
    })
    const b = ctx(() => textResponse('upstream error', 502))
    expect(await failureOf(adapter.refresh('r', b.ctx))).toMatchObject({
      kind: 'transient',
      code: 'transient.http_502',
    })
    const d = ctx(() => textResponse('{"access_token": ', 200))
    expect(await failureOf(adapter.refresh('r', d.ctx))).toMatchObject({
      code: 'transient.malformed_response',
    })
  })
})

describe('Google identity and access checks', () => {
  it('identifies the account from the id token (no extra request)', async () => {
    const { ctx: c, calls } = ctx(() => jsonResponse({}, 500))
    const id = await adapter.identify(
      {
        accessToken: 'a',
        accessTokenExpiresAt: null,
        refreshToken: 'r',
        grantedScopes: [],
        idToken: googleIdToken(now),
      },
      c,
    )
    expect(id).toEqual({
      externalAccountId: GOOGLE_SUB,
      accountLabel: GOOGLE_EMAIL,
      accountKind: 'personal',
    })
    expect(calls).toHaveLength(0)
  })

  it('falls back to userinfo when the id token is for another client or expired', async () => {
    for (const bad of [
      { aud: 'someone-else' },
      { exp: Math.floor(now.getTime() / 1000) - 3600 },
      { iss: 'https://evil.test' },
    ]) {
      const { ctx: c, calls } = ctx(() =>
        jsonResponse({ ...googleUserinfo, hd: 'example.org', email: 'Owner@Example.org' }),
      )
      const id = await adapter.identify(
        {
          accessToken: 'a',
          accessTokenExpiresAt: null,
          refreshToken: 'r',
          grantedScopes: [],
          idToken: googleIdToken(now, bad),
        },
        c,
      )
      expect(id).toEqual({
        externalAccountId: GOOGLE_SUB,
        accountLabel: 'owner@example.org',
        accountKind: 'work_or_school',
      })
      expect(calls[0]!.url).toBe(GOOGLE_ENDPOINTS.userinfo)
      expect(calls[0]!.headers.authorization).toBe('Bearer a')
    }
  })

  it('verifies access through the Gmail profile when Gmail was granted', async () => {
    const { ctx: c, calls } = ctx(() => jsonResponse(gmailProfile))
    const check = await adapter.verifyAccess(
      'ya29.a',
      googleExchangeResponse(now).scope.split(' '),
      c,
    )
    expect(calls[0]!.url).toBe(GOOGLE_ENDPOINTS.gmailProfile)
    expect(check).toEqual({
      endpoint: 'gmail.users.getProfile',
      accountLabel: GOOGLE_EMAIL,
      externalAccountId: null,
      facts: { historyIdPresent: true },
    })
  })

  it('uses the calendar list when only calendar was granted, userinfo when neither', async () => {
    const a = ctx(() => jsonResponse(googleCalendarList))
    const check = await adapter.verifyAccess('t', GOOGLE_CALENDAR_ONLY_GRANTED.split(' '), a.ctx)
    expect(check.endpoint).toBe('calendar.calendarList.list')
    expect(a.calls[0]!.url).toBe(`${GOOGLE_ENDPOINTS.calendarList}?maxResults=1`)

    const b = ctx(() => jsonResponse(googleUserinfo))
    const idOnly = await adapter.verifyAccess('t', ['openid', 'email'], b.ctx)
    expect(idOnly).toMatchObject({ endpoint: 'openid.userinfo', externalAccountId: GOOGLE_SUB })
  })

  it('classifies Gmail API failures: 401, insufficient scope, rate limits, disabled API, 5xx', async () => {
    const scopes = googleExchangeResponse(now).scope.split(' ')
    const cases: [number, unknown, Record<string, string>, Partial<ConnectionFailure>][] = [
      [401, googleUnauthenticated, {}, { kind: 'auth', code: 'auth.unauthorized' }],
      [403, googleInsufficientScope, {}, { kind: 'auth', code: 'auth.insufficient_scope' }],
      [
        403,
        googleUserRateLimit,
        {},
        { kind: 'rate_limited', code: 'rate_limited.userratelimitexceeded' },
      ],
      [
        429,
        googleTooManyRequests,
        { 'retry-after': '120' },
        { kind: 'rate_limited', retryAfterMs: 120_000 },
      ],
      [403, googleApiDisabled, {}, { kind: 'config', code: 'config.api_disabled' }],
      [
        403,
        { error: { code: 403, status: 'PERMISSION_DENIED' } },
        {},
        { kind: 'auth', code: 'auth.forbidden' },
      ],
      [503, googleUnavailable, {}, { kind: 'transient', code: 'transient.http_503' }],
    ]
    for (const [status, body, headers, expected] of cases) {
      const { ctx: c } = ctx(() => jsonResponse(body, status, headers))
      const f = await failureOf(adapter.verifyAccess('ya29.secret-access', scopes, c))
      expect(f).toMatchObject(expected)
      expect(f.message).not.toContain('ya29.secret-access')
      expect(f.message).not.toContain('project 000000000000')
    }
  })
})

describe('Google revoke', () => {
  it('posts the token form-encoded and reports the outcome without throwing', async () => {
    const ok = ctx(() => textResponse('', 200))
    expect(await adapter.revoke('1//rt', ok.ctx)).toBe('revoked')
    expect(ok.calls[0]!.url).toBe(GOOGLE_ENDPOINTS.revoke)
    expect(formBody(ok.calls[0]!)).toEqual({ token: '1//rt' })

    const gone = ctx(() =>
      jsonResponse({ error: 'invalid_token', error_description: 'Token expired or revoked' }, 400),
    )
    expect(await adapter.revoke('1//rt', gone.ctx)).toBe('already_invalid')

    const down = ctx(() => textResponse('', 503))
    expect(await adapter.revoke('1//rt', down.ctx)).toBe('failed')

    const net = ctx(() => {
      throw new TypeError('fetch failed')
    })
    expect(await adapter.revoke('1//rt', net.ctx)).toBe('failed')
  })
})
