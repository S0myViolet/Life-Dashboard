// Tests use SYNTHETIC FIXTURES (not captured from the live service): see fixtures/microsoft.ts.
import { describe, expect, it } from 'vitest'
import {
  connectionScopeCoverage,
  isConnectionError,
  type ConnectionFailure,
} from '@personal-home/core'
import { createMicrosoftAdapter, microsoftEndpoints } from '../src/index.ts'
import {
  createFakeFetch,
  formBody,
  jsonResponse,
  textResponse,
  type FakeHandler,
} from './fixtures/fake-fetch.ts'
import {
  MICROSOFT_TEST_CLIENT,
  MS_EMAIL,
  MS_NO_CALENDAR_GRANTED,
  MS_PERSONAL_ID,
  MS_WORK_ID,
  graphAccessDenied,
  graphInvalidToken,
  graphServiceUnavailable,
  graphTooManyRequests,
  msExchangeResponse,
  msInvalidClient,
  msInvalidGrant,
  msMePersonal,
  msMeWork,
  msRefreshResponse,
} from './fixtures/microsoft.ts'

const now = new Date('2026-09-24T10:00:00Z')
const adapter = createMicrosoftAdapter(MICROSOFT_TEST_CLIENT)
const endpoints = microsoftEndpoints('common')
const REDIRECT = 'https://home.example.test/api/connections/microsoft/callback'
const SCOPE = 'offline_access openid profile email User.Read Mail.Read Calendars.Read'

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

describe('Microsoft authorization URL', () => {
  it('uses /common v2.0 with delegated read scopes, PKCE S256, query response mode and account picker', () => {
    const url = new URL(
      adapter.authorize({
        state: 'S'.repeat(43),
        codeChallenge: 'C'.repeat(43),
        redirectUri: REDIRECT,
      }),
    )
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    )
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: MICROSOFT_TEST_CLIENT.clientId,
      response_type: 'code',
      redirect_uri: REDIRECT,
      response_mode: 'query',
      scope: SCOPE,
      state: 'S'.repeat(43),
      code_challenge: 'C'.repeat(43),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    })
  })
})

describe('Microsoft code exchange and refresh', () => {
  it('redeems the code as a confidential client (URL-encoded secret, verifier, scope)', async () => {
    const { ctx: c, calls } = ctx(() => jsonResponse(msExchangeResponse()))
    const tokens = await adapter.exchange(
      { code: 'M.C507_code', codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT },
      c,
    )
    expect(calls[0]!.url).toBe(endpoints.token)
    // '+' and '=' in the secret must be percent-encoded, not sent raw.
    expect(calls[0]!.body).toContain('client_secret=synthetic%7Esecret.value_with%2Bchars%3D')
    expect(formBody(calls[0]!)).toEqual({
      client_id: MICROSOFT_TEST_CLIENT.clientId,
      scope: SCOPE,
      code: 'M.C507_code',
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
      code_verifier: 'v'.repeat(43),
      client_secret: MICROSOFT_TEST_CLIENT.clientSecret,
    })
    expect(tokens.refreshToken).toBe('M.C507_BAY.0.U.-synthetic-refresh-1')
    expect(tokens.grantedScopes).toEqual([
      'openid',
      'profile',
      'email',
      'Calendars.Read',
      'Mail.Read',
      'User.Read',
    ])
  })

  it('returns the rotated refresh token on every refresh', async () => {
    let n = 1
    const { ctx: c, calls } = ctx(() => jsonResponse(msRefreshResponse(++n)))
    const first = await adapter.refresh('M.C507_BAY.0.U.-synthetic-refresh-1', c)
    const second = await adapter.refresh(first.refreshToken!, c)
    expect(first.refreshToken).toBe('M.C507_BAY.0.U.-synthetic-refresh-2')
    expect(second.refreshToken).toBe('M.C507_BAY.0.U.-synthetic-refresh-3')
    expect(formBody(calls[1]!)).toEqual({
      client_id: MICROSOFT_TEST_CLIENT.clientId,
      grant_type: 'refresh_token',
      refresh_token: 'M.C507_BAY.0.U.-synthetic-refresh-2',
      client_secret: MICROSOFT_TEST_CLIENT.clientSecret,
      scope: SCOPE,
    })
    expect(second.accessTokenExpiresAt).toEqual(new Date(now.getTime() + 3599_000))
  })

  it('invalid_grant → reconnect; invalid client secret → configuration; neither leaks AADSTS text or secrets', async () => {
    const a = ctx(() => jsonResponse(msInvalidGrant, 400))
    const f1 = await failureOf(adapter.refresh('M.C507_secret-refresh', a.ctx))
    expect(f1).toMatchObject({ kind: 'auth', code: 'auth.invalid_grant' })
    expect(f1.message).not.toMatch(/AADSTS|Trace ID|M\.C507/)

    const b = ctx(() => jsonResponse(msInvalidClient, 401))
    const f2 = await failureOf(adapter.refresh('r', b.ctx))
    expect(f2).toMatchObject({ kind: 'config', code: 'config.invalid_client' })
    expect(f2.message).not.toContain(MICROSOFT_TEST_CLIENT.clientSecret)
  })

  it('records partially granted scopes', async () => {
    const { ctx: c } = ctx(() =>
      jsonResponse(msExchangeResponse({ scope: MS_NO_CALENDAR_GRANTED })),
    )
    const tokens = await adapter.exchange(
      { code: 'c', codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT },
      c,
    )
    expect(connectionScopeCoverage('microsoft', tokens.grantedScopes!)).toEqual({
      missing: ['Calendars.Read'],
      mail: true,
      calendar: false,
    })
  })
})

describe('Microsoft identity and access checks', () => {
  it('identifies personal accounts via GET /me and the consumer tenant id', async () => {
    const { ctx: c, calls } = ctx(() => jsonResponse(msMePersonal))
    const tokens = {
      accessToken: 'EwB-access',
      accessTokenExpiresAt: null,
      refreshToken: 'r',
      grantedScopes: [],
      idToken: msExchangeResponse().id_token,
    }
    expect(await adapter.identify(tokens, c)).toEqual({
      externalAccountId: MS_PERSONAL_ID,
      accountLabel: MS_EMAIL,
      accountKind: 'personal',
    })
    expect(calls[0]!.url).toBe(endpoints.me)
    expect(calls[0]!.headers.authorization).toBe('Bearer EwB-access')
  })

  it('identifies work accounts (mail preferred, lower-cased)', async () => {
    const { ctx: c } = ctx(() => jsonResponse(msMeWork))
    const tokens = {
      accessToken: 'a',
      accessTokenExpiresAt: null,
      refreshToken: 'r',
      grantedScopes: [],
      idToken: msExchangeResponse({ tid: '11111111-2222-3333-4444-555555555555' }).id_token,
    }
    expect(await adapter.identify(tokens, c)).toEqual({
      externalAccountId: MS_WORK_ID,
      accountLabel: 'owner.synthetic@example.org',
      accountKind: 'work_or_school',
    })
  })

  it('verifyAccess reports the Graph id so a mismatched account can be detected', async () => {
    const { ctx: c } = ctx(() => jsonResponse(msMePersonal))
    expect(await adapter.verifyAccess('a', [], c)).toEqual({
      endpoint: 'graph.me',
      accountLabel: MS_EMAIL,
      externalAccountId: MS_PERSONAL_ID,
      facts: {},
    })
  })

  it('classifies Graph 401, 403, 429 Retry-After, 503 and malformed JSON', async () => {
    const cases: [number, unknown, Record<string, string>, Partial<ConnectionFailure>][] = [
      [401, graphInvalidToken, {}, { kind: 'auth', code: 'auth.unauthorized' }],
      [403, graphAccessDenied, {}, { kind: 'auth', code: 'auth.forbidden' }],
      [
        429,
        graphTooManyRequests,
        { 'retry-after': '10' },
        { kind: 'rate_limited', retryAfterMs: 10_000 },
      ],
      [
        503,
        graphServiceUnavailable,
        { 'retry-after': '20' },
        { kind: 'transient', code: 'transient.http_503', retryAfterMs: 20_000 },
      ],
    ]
    for (const [status, body, headers, expected] of cases) {
      const { ctx: c } = ctx(() => jsonResponse(body, status, headers))
      expect(await failureOf(adapter.verifyAccess('EwB-secret', [], c))).toMatchObject(expected)
    }
    const bad = ctx(() => textResponse('not json', 200))
    expect(await failureOf(adapter.verifyAccess('a', [], bad.ctx))).toMatchObject({
      code: 'transient.malformed_response',
    })
  })
})

describe('Microsoft revoke', () => {
  it('has no revocation endpoint and says so without calling the network', async () => {
    const { ctx: c, calls } = ctx(() => jsonResponse({}))
    expect(adapter.supportsRevoke).toBe(false)
    expect(await adapter.revoke('r', c)).toBe('not_supported')
    expect(calls).toHaveLength(0)
  })
})
