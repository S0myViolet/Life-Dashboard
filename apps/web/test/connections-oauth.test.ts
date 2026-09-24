// Provider responses are SYNTHETIC FIXTURES (not captured from the live service).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  connectionDecryptToken,
  oauthStateVerifierContext,
  sha256Hex,
  decryptSecret,
} from '@personal-home/core'
import {
  connectionApplyEvent,
  connectionGet,
  connectionRename,
  connectionTokensGet,
  withService,
  type ConnectionTokensRow,
} from '@personal-home/db'
import { oauthCodeChallengeS256 } from '@personal-home/integrations'
import {
  connectionOAuthBegin,
  connectionOAuthComplete,
  oauthResultLocation,
  safeConnectionsReturnTo,
} from '@/lib/integrations/oauth-flow'
import {
  GOOGLE_EMAIL,
  GOOGLE_SUB,
  GOOGLE_CALENDAR_ONLY_GRANTED,
  googleExchangeResponse,
  googleInvalidClient,
  googleInvalidGrant,
  googleUnavailable,
} from '../../../packages/integrations/test/fixtures/google.ts'
import { MS_EMAIL, MS_PERSONAL_ID } from '../../../packages/integrations/test/fixtures/microsoft.ts'
import {
  APP_URL,
  GOOGLE_TOKEN_URL,
  jsonResponse,
  providerFetch,
  setupConnectionsTest,
  type ConnectionsTestEnv,
  type ProviderScript,
} from './connections-helpers'

let env: ConnectionsTestEnv
let clock: Date
const now = () => clock

beforeAll(async () => {
  env = await setupConnectionsTest()
})
afterAll(async () => {
  await env?.t.drop()
})
beforeEach(async () => {
  clock = new Date('2026-09-24T10:00:00Z')
  await env.t.db`delete from public.connections`
  await env.t.db`delete from public.connection_events`
  await env.t.db`delete from private.oauth_states`
})

const redirectUri = (p: 'google' | 'microsoft') => `${APP_URL}/api/connections/${p}/callback`

function deps(provider: 'google' | 'microsoft' = 'google') {
  return {
    db: env.t.db,
    provider,
    redirectUri: redirectUri(provider),
    key: env.key,
    setting: env.setting,
  }
}

async function begin(
  provider: 'google' | 'microsoft' = 'google',
  extra: { reconnectConnectionId?: string } = {},
) {
  const r = await connectionOAuthBegin({
    ...deps(provider),
    returnTo: '/settings/connections',
    ...extra,
  })
  if (!r.ok) throw new Error(`begin failed: ${r.error}`)
  return r
}

async function complete(
  provider: 'google' | 'microsoft',
  query: Record<string, string>,
  cookieState: string | undefined,
  script: ProviderScript = {},
) {
  const fake = providerFetch(now, script)
  const result = await connectionOAuthComplete({
    ...deps(provider),
    query: new URLSearchParams(query),
    cookieState,
    fetch: fake.fetch,
    now,
  })
  return { result, calls: fake.calls }
}

async function ownerSnapshot() {
  const [owner] = await env.t.db`select user_id, email from private.owner`
  const [users] = await env.t.db<{ n: number }[]>`select count(*)::int as n from auth.users`
  return { owner, users: users!.n }
}

describe('begin', () => {
  it('stores only the state hash and an encrypted PKCE verifier, and returns the consent URL', async () => {
    const r = await begin('google')
    const url = new URL(r.authorizationUrl)
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('state')).toBe(r.state)
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri('google'))
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')

    const rows = await env.t.db<
      { stateHash: string; codeVerifierCiphertext: string; returnTo: string }[]
    >`
      select state_hash, code_verifier_ciphertext, return_to from private.oauth_states`
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.stateHash).toBe(await sha256Hex(r.state))
    expect(row.stateHash).not.toContain(r.state)
    expect(row.returnTo).toBe('/settings/connections')
    // The verifier is encrypted, bound to the state hash, and matches the challenge sent.
    const verifier = await decryptSecret(
      row.codeVerifierCiphertext,
      env.key,
      oauthStateVerifierContext(row.stateHash),
    )
    expect(row.codeVerifierCiphertext).not.toContain(verifier)
    expect(await oauthCodeChallengeS256(verifier)).toBe(url.searchParams.get('code_challenge'))
  })

  it('needs setup when provider settings or the encryption key are missing', async () => {
    const missing = await connectionOAuthBegin({ ...deps('google'), setting: () => undefined })
    expect(missing).toEqual({ ok: false, error: 'needs_setup' })
    const noKey = await connectionOAuthBegin({ ...deps('microsoft'), key: null })
    expect(noKey).toEqual({ ok: false, error: 'needs_setup' })
    const [n] = await env.t.db<{ n: number }[]>`select count(*)::int as n from private.oauth_states`
    expect(n!.n).toBe(0)
  })

  it('pre-fills the account picker when reconnecting a known account, refuses unknown ids', async () => {
    const r = await begin('google')
    const { result } = await complete('google', { state: r.state, code: 'synthetic-code' }, r.state)
    if (!result.ok) throw new Error(result.error)
    const again = await begin('google', { reconnectConnectionId: result.connectionId })
    expect(new URL(again.authorizationUrl).searchParams.get('login_hint')).toBe(GOOGLE_EMAIL)
    const unknown = await connectionOAuthBegin({
      ...deps('google'),
      reconnectConnectionId: '00000000-0000-4000-8000-000000000000',
    })
    expect(unknown).toEqual({ ok: false, error: 'unknown_account' })
    const wrongProvider = await connectionOAuthBegin({
      ...deps('microsoft'),
      reconnectConnectionId: result.connectionId,
    })
    expect(wrongProvider).toEqual({ ok: false, error: 'unknown_account' })
  })
})

describe('complete', () => {
  it('connects a Google account: exchange with the PKCE verifier, identify, verify, encrypt, record', async () => {
    const before = await ownerSnapshot()
    const r = await begin('google')
    const { result, calls } = await complete(
      'google',
      { state: r.state, code: 'synthetic-code' },
      r.state,
    )
    expect(result).toMatchObject({
      ok: true,
      outcome: 'connected',
      accessChecked: true,
      returnTo: '/settings/connections',
    })
    if (!result.ok) return

    const tokenCall = calls.find((c) => c.url === GOOGLE_TOKEN_URL)!
    const form = Object.fromEntries(new URLSearchParams(tokenCall.body))
    expect(form).toMatchObject({
      grant_type: 'authorization_code',
      code: 'synthetic-code',
      redirect_uri: redirectUri('google'),
    })
    const challenge = new URL(r.authorizationUrl).searchParams.get('code_challenge')
    expect(await oauthCodeChallengeS256(form.code_verifier!)).toBe(challenge)

    const conn = (await withService(env.t.db, (tx) => connectionGet(tx, result.connectionId)))!
    expect(conn).toMatchObject({
      provider: 'google',
      externalAccountId: GOOGLE_SUB,
      accountLabel: GOOGLE_EMAIL,
      status: 'connected',
      lastErrorCode: null,
    })
    expect(conn.grantedScopes).toContain('https://www.googleapis.com/auth/gmail.readonly')
    expect(conn.grantedScopes).toContain('email')

    const tok = (await withService(env.t.db, (tx) =>
      connectionTokensGet(tx, conn.id),
    )) as ConnectionTokensRow
    expect(tok.refreshTokenCiphertext).not.toContain('synthetic-refresh')
    expect(
      await connectionDecryptToken(env.key, conn.id, 'refresh_token', tok.refreshTokenCiphertext),
    ).toBe('1//synthetic-refresh-token-1')
    expect(
      await connectionDecryptToken(env.key, conn.id, 'access_token', tok.accessTokenCiphertext!),
    ).toBe('ya29.synthetic-access-token-1')
    // Tokens are bound to their row and purpose.
    await expect(
      connectionDecryptToken(env.key, conn.id, 'access_token', tok.refreshTokenCiphertext),
    ).rejects.toThrow()
    expect(tok.accessTokenExpiresAt?.getTime()).toBe(clock.getTime() + 3599_000)

    const events = await env.t.db`select kind, account_label from public.connection_events`
    expect(events).toEqual([{ kind: 'connected', accountLabel: GOOGLE_EMAIL }])

    // Connecting a mailbox never changes the dashboard owner or creates app users.
    expect(await ownerSnapshot()).toEqual(before)
    expect(oauthResultLocation('google', result)).toBe(
      '/settings/connections?provider=google&result=connected',
    )
  })

  it('states are single use', async () => {
    const r = await begin('google')
    const first = await complete('google', { state: r.state, code: 'c1' }, r.state)
    expect(first.result.ok).toBe(true)
    const replay = await complete('google', { state: r.state, code: 'c1' }, r.state)
    expect(replay.result).toMatchObject({ ok: false, error: 'state_expired' })
    expect(replay.calls).toHaveLength(0)
  })

  it('refuses a callback from another browser without consuming the state', async () => {
    const r = await begin('google')
    const other = await begin('google')
    const noCookie = await complete('google', { state: r.state, code: 'c' }, undefined)
    expect(noCookie.result).toMatchObject({ ok: false, error: 'state_mismatch' })
    const wrongCookie = await complete('google', { state: r.state, code: 'c' }, other.state)
    expect(wrongCookie.result).toMatchObject({ ok: false, error: 'state_mismatch' })
    expect(noCookie.calls.length + wrongCookie.calls.length).toBe(0)
    // The legitimate browser can still finish.
    const ok = await complete('google', { state: r.state, code: 'c' }, r.state)
    expect(ok.result.ok).toBe(true)
  })

  it('rejects malformed, expired and cross-provider states', async () => {
    const bad = await complete('google', { state: 'short', code: 'c' }, 'short')
    expect(bad.result).toMatchObject({ ok: false, error: 'invalid_request' })

    const g = await begin('google')
    const cross = await complete('microsoft', { state: g.state, code: 'c' }, g.state)
    expect(cross.result).toMatchObject({ ok: false, error: 'state_expired' })

    const old = await begin('google')
    await env.t.db`update private.oauth_states
      set created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes'
      where state_hash = ${await sha256Hex(old.state)}`
    const expired = await complete('google', { state: old.state, code: 'c' }, old.state)
    expect(expired.result).toMatchObject({ ok: false, error: 'state_expired' })
  })

  it('a cancelled consent consumes the state and connects nothing', async () => {
    const r = await begin('google')
    const { result, calls } = await complete(
      'google',
      { state: r.state, error: 'access_denied' },
      r.state,
    )
    expect(result).toMatchObject({ ok: false, error: 'denied' })
    expect(calls).toHaveLength(0)
    const other = await complete('google', { state: r.state, code: 'c' }, r.state)
    expect(other.result).toMatchObject({ ok: false, error: 'state_expired' })
    const [n] = await env.t.db<{ n: number }[]>`select count(*)::int as n from public.connections`
    expect(n!.n).toBe(0)
  })

  it('maps exchange failures to closed codes and never echoes provider text', async () => {
    const cases: [ProviderScript['googleToken'], string][] = [
      [() => jsonResponse(googleInvalidGrant, 400), 'exchange_failed'],
      [() => jsonResponse(googleInvalidClient, 401), 'client_rejected'],
      [() => jsonResponse(googleUnavailable, 503), 'provider_unavailable'],
      [() => jsonResponse({}, 429, { 'retry-after': '30' }), 'rate_limited'],
      [() => new Response('<html>oops</html>', { status: 200 }), 'provider_unavailable'],
    ]
    for (const [googleToken, error] of cases) {
      const r = await begin('google')
      const { result } = await complete('google', { state: r.state, code: 'c' }, r.state, {
        googleToken,
      })
      expect(result).toMatchObject({ ok: false, error })
      const location = oauthResultLocation('google', result)
      expect(location).toBe(`/settings/connections?provider=google&error=${error}`)
    }
    const [n] = await env.t.db<{ n: number }[]>`select count(*)::int as n from public.connections`
    expect(n!.n).toBe(0)
  })

  it('refuses a grant without a refresh token (no offline access)', async () => {
    const r = await begin('google')
    const { refresh_token: _drop, ...noRefresh } = googleExchangeResponse(clock)
    void _drop
    const { result } = await complete('google', { state: r.state, code: 'c' }, r.state, {
      googleToken: () => jsonResponse(noRefresh),
    })
    expect(result).toMatchObject({ ok: false, error: 'no_refresh_token' })
    const [n] = await env.t.db<{ n: number }[]>`select count(*)::int as n from public.connections`
    expect(n!.n).toBe(0)
  })

  it('records a partial grant honestly (calendar granted, Gmail declined)', async () => {
    const r = await begin('google')
    const { result, calls } = await complete('google', { state: r.state, code: 'c' }, r.state, {
      googleToken: () => jsonResponse(googleExchangeResponse(clock, GOOGLE_CALENDAR_ONLY_GRANTED)),
    })
    expect(result).toMatchObject({ ok: true, accessChecked: true })
    if (!result.ok) return
    const conn = (await withService(env.t.db, (tx) => connectionGet(tx, result.connectionId)))!
    expect(conn.grantedScopes).not.toContain('https://www.googleapis.com/auth/gmail.readonly')
    expect(conn.grantedScopes).toContain('https://www.googleapis.com/auth/calendar.events.readonly')
    // Access was proven through the calendar list, not Gmail.
    expect(calls.some((c) => c.url.includes('/gmail/'))).toBe(false)
    expect(calls.some((c) => c.url.includes('/calendarList'))).toBe(true)
  })

  it('connects but records a failed first access check instead of hiding it', async () => {
    const r = await begin('google')
    const { result } = await complete('google', { state: r.state, code: 'c' }, r.state, {
      gmailProfile: () => jsonResponse(googleUnavailable, 503),
    })
    expect(result).toMatchObject({ ok: true, outcome: 'connected', accessChecked: false })
    if (!result.ok) return
    expect(oauthResultLocation('google', result)).toBe(
      '/settings/connections?provider=google&result=connected&check=failed',
    )
    const conn = (await withService(env.t.db, (tx) => connectionGet(tx, result.connectionId)))!
    expect(conn.status).toBe('error')
    expect(conn.lastErrorCode).toBe('transient.http_503')
    expect(conn.nextAttemptAt).not.toBeNull()
  })

  it('reconnecting the same account keeps its label and pause, and replaces its tokens', async () => {
    const first = await begin('google')
    const a = await complete('google', { state: first.state, code: 'c1' }, first.state)
    if (!a.result.ok) throw new Error('first connect failed')
    const id = a.result.connectionId
    await withService(env.t.db, async (tx) => {
      await connectionRename(tx, id, 'Personal Gmail')
      await connectionApplyEvent(tx, id, { type: 'paused', at: clock })
    })

    clock = new Date('2026-09-25T10:00:00Z')
    const second = await begin('google')
    const b = await complete('google', { state: second.state, code: 'c2' }, second.state, {
      googleToken: () =>
        jsonResponse({
          ...googleExchangeResponse(clock),
          refresh_token: '1//synthetic-refresh-token-2',
        }),
    })
    expect(b.result).toMatchObject({ ok: true, outcome: 'reconnected', connectionId: id })
    const conn = (await withService(env.t.db, (tx) => connectionGet(tx, id)))!
    expect(conn.accountLabel).toBe('Personal Gmail')
    expect(conn.status).toBe('paused')
    const tok = (await withService(env.t.db, (tx) =>
      connectionTokensGet(tx, id),
    )) as ConnectionTokensRow
    expect(
      await connectionDecryptToken(env.key, id, 'refresh_token', tok.refreshTokenCiphertext),
    ).toBe('1//synthetic-refresh-token-2')
    const [n] = await env.t.db<{ n: number }[]>`select count(*)::int as n from public.connections`
    expect(n!.n).toBe(1)
  })

  it('connects a Microsoft account as a confidential client and labels it from Graph', async () => {
    const r = await begin('microsoft')
    const url = new URL(r.authorizationUrl)
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    )
    const { result, calls } = await complete(
      'microsoft',
      { state: r.state, code: 'M.C507_synthetic' },
      r.state,
    )
    expect(result).toMatchObject({ ok: true, outcome: 'connected', accessChecked: true })
    if (!result.ok) return
    const form = Object.fromEntries(new URLSearchParams(calls[0]!.body))
    expect(form.client_secret).toBeDefined()
    expect(form.redirect_uri).toBe(redirectUri('microsoft'))
    const conn = (await withService(env.t.db, (tx) => connectionGet(tx, result.connectionId)))!
    expect(conn).toMatchObject({
      provider: 'microsoft',
      externalAccountId: MS_PERSONAL_ID,
      accountLabel: MS_EMAIL,
    })
    expect(conn.grantedScopes).toEqual(
      expect.arrayContaining(['User.Read', 'Mail.Read', 'Calendars.Read']),
    )
  })
})

describe('redirect safety', () => {
  it('only returns to settings paths', () => {
    expect(safeConnectionsReturnTo('/settings/connections')).toBe('/settings/connections')
    expect(safeConnectionsReturnTo('/settings')).toBe('/settings')
    for (const bad of [
      '//evil.example',
      'https://evil.example',
      '/settings/../x',
      '/settings?x=1',
      '/',
      null,
      '/SETTINGS',
    ])
      expect(safeConnectionsReturnTo(bad)).toBe('/settings/connections')
  })
})
