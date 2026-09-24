// Provider responses are SYNTHETIC FIXTURES (not captured from the live service),
// shaped from docs/research/oauth.md; see packages/integrations/test/fixtures.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  bytesToBase64,
  connectionDecryptToken,
  connectionEncryptToken,
  connectionEncryptionKey,
  type EncryptionKey,
} from '@personal-home/core'
import {
  connectionApplyEvent,
  connectionGet,
  connectionTokensGet,
  connectionTokensSave,
  connectionUpsertAuthorized,
  withService,
  type ConnectionTokensRow,
} from '@personal-home/db'
import { createTestDatabase, type TestDatabase } from '@personal-home/db/testing'
// Brings in the vitest `ProvidedContext` augmentation (templateDb) for type-checking.
import type {} from '../../db/test/global-setup.ts'
import { connectionHandlers, type ConnectionJobContext } from '../src/index.ts'
import {
  createFakeFetch,
  formBody,
  jsonResponse,
  textResponse,
  type FakeHandler,
  type RecordedRequest,
} from '../../integrations/test/fixtures/fake-fetch.ts'
import {
  GOOGLE_TEST_CLIENT,
  gmailProfile,
  googleInvalidGrant,
  googleRefreshResponse,
  googleTooManyRequests,
  googleUnauthenticated,
} from '../../integrations/test/fixtures/google.ts'
import {
  MICROSOFT_TEST_CLIENT,
  msMePersonal,
  msRefreshResponse,
} from '../../integrations/test/fixtures/microsoft.ts'

const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const GMAIL_PROFILE = 'https://gmail.googleapis.com/gmail/v1/users/me/profile'
const MS_TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const GRAPH_ME = 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName'
const GMAIL_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly']

let t: TestDatabase
let key: EncryptionKey
let keyB64: string
let clock: Date

beforeAll(async () => {
  t = await createTestDatabase()
  keyB64 = bytesToBase64(new Uint8Array(randomBytes(32)))
  key = (await connectionEncryptionKey(keyB64))!
})
afterAll(async () => {
  await t?.drop()
})
beforeEach(async () => {
  clock = new Date('2026-09-24T10:00:00Z')
  await t.db`delete from public.connections`
})

const minutes = (n: number) => new Date(clock.getTime() + n * 60_000)

function env(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    TOKEN_ENCRYPTION_KEY: keyB64,
    GOOGLE_OAUTH_CLIENT_ID: GOOGLE_TEST_CLIENT.clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: GOOGLE_TEST_CLIENT.clientSecret,
    MICROSOFT_CLIENT_ID: MICROSOFT_TEST_CLIENT.clientId,
    MICROSOFT_CLIENT_SECRET: MICROSOFT_TEST_CLIENT.clientSecret,
    ...overrides,
  }
  return (name: string) => values[name]
}

function jobCtx(handler: FakeHandler, extra: Partial<ConnectionJobContext> = {}) {
  const fake = createFakeFetch(handler)
  const ctx: ConnectionJobContext = {
    db: t.db,
    now: () => clock,
    fetch: fake.fetch,
    signal: new AbortController().signal,
    env: env(),
    ...extra,
  }
  return { ctx, calls: fake.calls }
}

const job = (kind: 'sync.google' | 'sync.microsoft', payload: unknown = {}) => ({
  id: 'job-1',
  kind,
  payload,
})

async function seed(opts: {
  provider: 'google' | 'microsoft'
  externalId: string
  refreshToken: string
  accessToken?: string
  accessExpiresAt?: Date | null
  scopes?: string[]
}) {
  return withService(t.db, async (tx) => {
    const { connection } = await connectionUpsertAuthorized(tx, {
      provider: opts.provider,
      externalAccountId: opts.externalId,
      accountLabel: `${opts.externalId}@example.com`,
      grantedScopes:
        opts.scopes ?? (opts.provider === 'google' ? GMAIL_SCOPES : ['User.Read', 'Mail.Read']),
      at: new Date('2026-09-01T00:00:00Z'),
    })
    await connectionTokensSave(tx, {
      connectionId: connection.id,
      refreshTokenCiphertext: await connectionEncryptToken(
        key,
        connection.id,
        'refresh_token',
        opts.refreshToken,
      ),
      accessTokenCiphertext: opts.accessToken
        ? await connectionEncryptToken(key, connection.id, 'access_token', opts.accessToken)
        : null,
      accessTokenExpiresAt: opts.accessExpiresAt ?? null,
      keyVersion: 1,
    })
    return connection.id
  })
}

const get = (id: string) => withService(t.db, (tx) => connectionGet(tx, id))
async function tokens(id: string) {
  const row = (await withService(t.db, (tx) => connectionTokensGet(tx, id))) as ConnectionTokensRow
  return {
    refresh: await connectionDecryptToken(key, id, 'refresh_token', row.refreshTokenCiphertext),
    access: row.accessTokenCiphertext
      ? await connectionDecryptToken(key, id, 'access_token', row.accessTokenCiphertext)
      : null,
    expiresAt: row.accessTokenExpiresAt,
  }
}

const bearer = (r: RecordedRequest) => r.headers.authorization?.replace(/^Bearer /, '')

describe('sync.google background access check', () => {
  it('refreshes an expired access token, persists it, calls Gmail profile and records success', async () => {
    const id = await seed({
      provider: 'google',
      externalId: 'g1',
      refreshToken: '1//rt-g1',
      accessToken: 'ya29.old',
      accessExpiresAt: minutes(-1),
    })
    const { ctx, calls } = jobCtx((req) => {
      if (req.url === GOOGLE_TOKEN) return jsonResponse(googleRefreshResponse)
      if (req.url === GMAIL_PROFILE) return jsonResponse(gmailProfile)
      return textResponse('unexpected', 500)
    })
    expect(await connectionHandlers['sync.google'](ctx, job('sync.google'))).toEqual({
      status: 'succeeded',
    })
    expect(calls.map((c) => c.url)).toEqual([GOOGLE_TOKEN, GMAIL_PROFILE])
    expect(formBody(calls[0]!)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: '1//rt-g1',
    })
    expect(bearer(calls[1]!)).toBe('ya29.synthetic-access-token-2')

    expect(await tokens(id)).toEqual({
      refresh: '1//rt-g1',
      access: 'ya29.synthetic-access-token-2',
      expiresAt: new Date(clock.getTime() + 3599_000),
    })
    expect(await get(id)).toMatchObject({
      status: 'connected',
      lastAttemptAt: clock,
      lastSuccessAt: clock,
      lastErrorCode: null,
      nextAttemptAt: null,
    })
  })

  it('uses a still-valid access token without refreshing, and refreshes when it is near expiry', async () => {
    const fresh = await seed({
      provider: 'google',
      externalId: 'g-fresh',
      refreshToken: '1//a',
      accessToken: 'ya29.valid',
      accessExpiresAt: minutes(30),
    })
    const near = await seed({
      provider: 'google',
      externalId: 'g-near',
      refreshToken: '1//b',
      accessToken: 'ya29.near',
      accessExpiresAt: minutes(2),
    })
    const { ctx, calls } = jobCtx((req) =>
      req.url === GOOGLE_TOKEN ? jsonResponse(googleRefreshResponse) : jsonResponse(gmailProfile),
    )
    await connectionHandlers['sync.google'](ctx, job('sync.google'))
    const tokenCalls = calls.filter((c) => c.url === GOOGLE_TOKEN)
    expect(tokenCalls).toHaveLength(1)
    expect(formBody(tokenCalls[0]!).refresh_token).toBe('1//b')
    expect(
      calls
        .filter((c) => c.url === GMAIL_PROFILE)
        .map(bearer)
        .sort(),
    ).toEqual(['ya29.synthetic-access-token-2', 'ya29.valid'].sort())
    expect((await get(fresh))?.status).toBe('connected')
    expect((await tokens(near)).access).toBe('ya29.synthetic-access-token-2')
  })

  it('invalid_grant → needs_reconnect for that account while another account stays connected', async () => {
    const bad = await seed({
      provider: 'google',
      externalId: 'g-bad',
      refreshToken: '1//revoked',
      accessExpiresAt: null,
    })
    const good = await seed({
      provider: 'google',
      externalId: 'g-good',
      refreshToken: '1//fine',
      accessExpiresAt: null,
    })
    const { ctx } = jobCtx((req) => {
      if (req.url === GOOGLE_TOKEN)
        return formBody(req).refresh_token === '1//revoked'
          ? jsonResponse(googleInvalidGrant, 400)
          : jsonResponse(googleRefreshResponse)
      return jsonResponse(gmailProfile)
    })
    expect(await connectionHandlers['sync.google'](ctx, job('sync.google'))).toEqual({
      status: 'succeeded',
    })
    expect(await get(bad)).toMatchObject({
      status: 'needs_reconnect',
      lastErrorCode: 'auth.invalid_grant',
      nextAttemptAt: null,
    })
    expect((await get(bad))?.lastErrorMessage).not.toMatch(/revoked|1\/\//)
    expect(await get(good)).toMatchObject({ status: 'connected', lastSuccessAt: clock })
    // The stored refresh token of the failed account is kept (reconnect replaces it; disconnect deletes it).
    expect((await tokens(bad)).refresh).toBe('1//revoked')

    // Next run: the needs_reconnect account is not retried.
    const second = jobCtx((req) =>
      req.url === GOOGLE_TOKEN ? jsonResponse(googleRefreshResponse) : jsonResponse(gmailProfile),
    )
    clock = minutes(60)
    await connectionHandlers['sync.google'](second.ctx, job('sync.google'))
    expect(
      second.calls.some(
        (c) => c.url === GOOGLE_TOKEN && formBody(c).refresh_token === '1//revoked',
      ),
    ).toBe(false)
  })

  it('429 → error with next_attempt_at from Retry-After; the account is skipped until then', async () => {
    const id = await seed({
      provider: 'google',
      externalId: 'g-429',
      refreshToken: '1//x',
      accessToken: 'ya29.ok',
      accessExpiresAt: minutes(60),
    })
    const first = jobCtx(() => jsonResponse(googleTooManyRequests, 429, { 'retry-after': '120' }))
    await connectionHandlers['sync.google'](first.ctx, job('sync.google'))
    expect(await get(id)).toMatchObject({
      status: 'error',
      lastErrorCode: 'rate_limited.resource_exhausted',
      nextAttemptAt: new Date(clock.getTime() + 120_000),
      consecutiveFailures: 1,
    })

    clock = minutes(1)
    const early = jobCtx(() => jsonResponse(gmailProfile))
    await connectionHandlers['sync.google'](early.ctx, job('sync.google'))
    expect(early.calls).toHaveLength(0)

    clock = minutes(2)
    const later = jobCtx(() => jsonResponse(gmailProfile))
    await connectionHandlers['sync.google'](later.ctx, job('sync.google'))
    expect(later.calls).toHaveLength(1)
    expect(await get(id)).toMatchObject({ status: 'connected', consecutiveFailures: 0 })
  })

  it('a single-connection job returns retry at the Retry-After time for 429/5xx', async () => {
    const id = await seed({
      provider: 'google',
      externalId: 'g-503',
      refreshToken: '1//x',
      accessExpiresAt: null,
    })
    const { ctx } = jobCtx(() =>
      textResponse('busy', 503, { 'retry-after': 'Thu, 24 Sep 2026 10:10:00 GMT' }),
    )
    const result = await connectionHandlers['sync.google'](
      ctx,
      job('sync.google', { connectionId: id }),
    )
    expect(result).toEqual({ status: 'retry', retryAt: minutes(10), error: 'transient.http_503' })
    expect(await get(id)).toMatchObject({ status: 'error', nextAttemptAt: minutes(10) })
  })

  it('paused connections are skipped and stay paused', async () => {
    const id = await seed({
      provider: 'google',
      externalId: 'g-paused',
      refreshToken: '1//x',
      accessExpiresAt: null,
    })
    await withService(t.db, (tx) => connectionApplyEvent(tx, id, { type: 'paused', at: clock }))
    const { ctx, calls } = jobCtx(() => jsonResponse(googleRefreshResponse))
    expect(await connectionHandlers['sync.google'](ctx, job('sync.google'))).toEqual({
      status: 'succeeded',
    })
    expect(
      await connectionHandlers['sync.google'](ctx, job('sync.google', { connectionId: id })),
    ).toEqual({ status: 'succeeded' })
    expect(calls).toHaveLength(0)
    expect(await get(id)).toMatchObject({
      status: 'paused',
      lastAttemptAt: new Date('2026-09-01T00:00:00Z'),
    })
  })

  it('a cached token rejected with 401 is refreshed once and the check retried', async () => {
    const id = await seed({
      provider: 'google',
      externalId: 'g-401',
      refreshToken: '1//x',
      accessToken: 'ya29.revoked-early',
      accessExpiresAt: minutes(50),
    })
    const { ctx, calls } = jobCtx((req) => {
      if (req.url === GOOGLE_TOKEN) return jsonResponse(googleRefreshResponse)
      return bearer(req) === 'ya29.revoked-early'
        ? jsonResponse(googleUnauthenticated, 401)
        : jsonResponse(gmailProfile)
    })
    await connectionHandlers['sync.google'](ctx, job('sync.google'))
    expect(calls.map((c) => c.url)).toEqual([GMAIL_PROFILE, GOOGLE_TOKEN, GMAIL_PROFILE])
    expect(await get(id)).toMatchObject({ status: 'connected' })
    expect((await tokens(id)).access).toBe('ya29.synthetic-access-token-2')
  })

  it('missing server settings are recorded on each account as a configuration error', async () => {
    const id = await seed({
      provider: 'google',
      externalId: 'g-cfg',
      refreshToken: '1//x',
      accessExpiresAt: null,
    })
    const { ctx, calls } = jobCtx(() => jsonResponse({}), {
      env: env({ GOOGLE_OAUTH_CLIENT_SECRET: undefined }),
    })
    expect(await connectionHandlers['sync.google'](ctx, job('sync.google'))).toEqual({
      status: 'failed',
      error: 'missing settings: GOOGLE_OAUTH_CLIENT_SECRET',
    })
    expect(calls).toHaveLength(0)
    expect(await get(id)).toMatchObject({
      status: 'error',
      lastErrorCode: 'config.missing_settings',
      lastErrorMessage: 'Background jobs are missing server settings: GOOGLE_OAUTH_CLIENT_SECRET',
    })
  })

  it('tokens that no longer decrypt (wrong key) become a configuration error, not a crash', async () => {
    const id = await seed({
      provider: 'google',
      externalId: 'g-key',
      refreshToken: '1//x',
      accessExpiresAt: null,
    })
    const otherKey = bytesToBase64(new Uint8Array(randomBytes(32)))
    const { ctx, calls } = jobCtx(() => jsonResponse(googleRefreshResponse), {
      env: env({ TOKEN_ENCRYPTION_KEY: otherKey }),
    })
    await connectionHandlers['sync.google'](ctx, job('sync.google'))
    expect(calls).toHaveLength(0)
    expect(await get(id)).toMatchObject({ status: 'error', lastErrorCode: 'config.decrypt_failed' })
  })

  it('two workers never refresh the same connection at once', async () => {
    const id = await seed({
      provider: 'google',
      externalId: 'g-race',
      refreshToken: '1//x',
      accessExpiresAt: null,
    })
    let releaseToken!: () => void
    const tokenGate = new Promise<void>((r) => (releaseToken = r))
    let tokenRequested!: () => void
    const requested = new Promise<void>((r) => (tokenRequested = r))
    const shared = createFakeFetch(async (req) => {
      if (req.url === GOOGLE_TOKEN) {
        tokenRequested()
        await tokenGate
        return jsonResponse(googleRefreshResponse)
      }
      return jsonResponse(gmailProfile)
    })
    const ctx: ConnectionJobContext = {
      db: t.db,
      now: () => clock,
      fetch: shared.fetch,
      signal: new AbortController().signal,
      env: env(),
    }
    const first = connectionHandlers['sync.google'](ctx, job('sync.google', { connectionId: id }))
    await requested
    const second = await connectionHandlers['sync.google'](
      ctx,
      job('sync.google', { connectionId: id }),
    )
    expect(second).toMatchObject({ status: 'retry', error: 'refresh in progress elsewhere' })
    releaseToken()
    expect(await first).toEqual({ status: 'succeeded' })
    expect(shared.calls.filter((c) => c.url === GOOGLE_TOKEN)).toHaveLength(1)
  })

  it('rejects malformed payloads and stops cleanly when cancelled', async () => {
    const { ctx } = jobCtx(() => jsonResponse({}))
    expect(
      await connectionHandlers['sync.google'](
        ctx,
        job('sync.google', { connectionId: 'not-a-uuid' }),
      ),
    ).toEqual({
      status: 'failed',
      error: 'invalid payload',
    })
    await seed({
      provider: 'google',
      externalId: 'g-cancel',
      refreshToken: '1//x',
      accessExpiresAt: null,
    })
    const controller = new AbortController()
    controller.abort()
    const cancelled = jobCtx(() => jsonResponse({}), { signal: controller.signal })
    expect(
      await connectionHandlers['sync.google'](cancelled.ctx, job('sync.google')),
    ).toMatchObject({ status: 'retry' })
    expect(cancelled.calls).toHaveLength(0)
  })
})

describe('sync.microsoft background access check', () => {
  it('persists the rotated refresh token every time and uses it next time', async () => {
    const id = await seed({
      provider: 'microsoft',
      externalId: msMePersonal.id,
      refreshToken: 'M.C507_rt-1',
      accessExpiresAt: minutes(-5),
    })
    let n = 1
    const handler: FakeHandler = (req) => {
      if (req.url === MS_TOKEN) return jsonResponse(msRefreshResponse(++n))
      if (req.url === GRAPH_ME) return jsonResponse(msMePersonal)
      return textResponse('unexpected', 500)
    }
    const first = jobCtx(handler)
    expect(await connectionHandlers['sync.microsoft'](first.ctx, job('sync.microsoft'))).toEqual({
      status: 'succeeded',
    })
    expect(formBody(first.calls[0]!).refresh_token).toBe('M.C507_rt-1')
    expect(await tokens(id)).toMatchObject({
      refresh: 'M.C507_BAY.0.U.-synthetic-refresh-2',
      access: 'EwB4A8l6BAAUsynthetic-access-2',
    })

    clock = new Date(clock.getTime() + 2 * 3600_000) // access token expired again
    const second = jobCtx(handler)
    await connectionHandlers['sync.microsoft'](second.ctx, job('sync.microsoft'))
    expect(formBody(second.calls[0]!).refresh_token).toBe('M.C507_BAY.0.U.-synthetic-refresh-2')
    expect((await tokens(id)).refresh).toBe('M.C507_BAY.0.U.-synthetic-refresh-3')
    expect(await get(id)).toMatchObject({ status: 'connected', lastSuccessAt: clock })
  })

  it('tokens that identify a different Graph user → needs_reconnect (account mismatch)', async () => {
    const id = await seed({
      provider: 'microsoft',
      externalId: 'someone-else',
      refreshToken: 'M.C507_rt',
      accessExpiresAt: null,
    })
    const { ctx } = jobCtx((req) =>
      req.url === MS_TOKEN ? jsonResponse(msRefreshResponse(2)) : jsonResponse(msMePersonal),
    )
    await connectionHandlers['sync.microsoft'](ctx, job('sync.microsoft'))
    expect(await get(id)).toMatchObject({
      status: 'needs_reconnect',
      lastErrorCode: 'auth.account_mismatch',
    })
  })

  it('does not touch Google connections', async () => {
    const g = await seed({
      provider: 'google',
      externalId: 'g-other',
      refreshToken: '1//x',
      accessExpiresAt: null,
    })
    const { ctx, calls } = jobCtx(() => jsonResponse({}))
    expect(await connectionHandlers['sync.microsoft'](ctx, job('sync.microsoft'))).toEqual({
      status: 'succeeded',
    })
    expect(
      await connectionHandlers['sync.microsoft'](ctx, job('sync.microsoft', { connectionId: g })),
    ).toEqual({
      status: 'failed',
      error: 'connection not found',
    })
    expect(calls).toHaveLength(0)
  })
})
