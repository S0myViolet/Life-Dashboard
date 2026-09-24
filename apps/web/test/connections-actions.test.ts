// Owner actions (pause, resume, rename, disconnect) against a real database.
// Provider responses are SYNTHETIC FIXTURES (not captured from the live service).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectionEncryptToken,
} from '@personal-home/core'
import {
  connectionGet,
  connectionTokensSave,
  connectionUpsertAuthorized,
  syncCursorUpsert,
  withService,
} from '@personal-home/db'
import {
  connectionAdminDisconnect,
  connectionAdminPause,
  connectionAdminRename,
  connectionAdminResume,
} from '@/lib/integrations/admin'
import {
  APP_URL,
  GOOGLE_REVOKE_URL,
  coreTestEnv,
  providerFetch,
  setupConnectionsTest,
  type ConnectionsTestEnv,
} from './connections-helpers'

// --- Next.js request context, replaced for the server-action tests --------------------------
const request = vi.hoisted(() => ({
  origin: null as string | null,
  owner: true,
  redirects: [] as string[],
  revalidated: [] as string[],
}))
vi.mock('next/headers', () => ({
  headers: async () => new Headers(request.origin ? { origin: request.origin } : {}),
}))
vi.mock('next/cache', () => ({
  revalidatePath: (p: string) => request.revalidated.push(p),
}))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    request.redirects.push(url)
    throw new Error('NEXT_REDIRECT')
  },
}))
vi.mock('@/lib/server/session', () => ({
  requireOwner: async () => {
    if (!request.owner) throw new Error('NEXT_REDIRECT /login')
    return { claims: { sub: 'x' }, userId: 'x', email: null }
  },
}))

let env: ConnectionsTestEnv
let clock: Date
const savedEnv = { ...process.env }

beforeAll(async () => {
  env = await setupConnectionsTest()
  Object.assign(process.env, coreTestEnv(env.t.url, env.keyB64), env.settings)
})
afterAll(async () => {
  const { getDb } = await import('@/lib/server/db')
  await getDb().end({ timeout: 5 })
  process.env = savedEnv
  vi.unstubAllGlobals()
  await env?.t.drop()
})
beforeEach(async () => {
  clock = new Date('2026-09-24T10:00:00Z')
  request.origin = APP_URL
  request.owner = true
  request.redirects = []
  request.revalidated = []
  vi.unstubAllGlobals()
  await env.t.db`delete from public.connections`
  await env.t.db`delete from public.connection_events`
})

async function seed(provider: 'google' | 'microsoft', externalId: string) {
  return withService(env.t.db, async (tx) => {
    const { connection } = await connectionUpsertAuthorized(tx, {
      provider,
      externalAccountId: externalId,
      accountLabel: `${externalId}@example.com`,
      grantedScopes: [],
      at: clock,
    })
    await connectionTokensSave(tx, {
      connectionId: connection.id,
      refreshTokenCiphertext: await connectionEncryptToken(env.key, connection.id, 'refresh_token', `refresh-${externalId}`),
      accessTokenCiphertext: null,
      accessTokenExpiresAt: null,
      keyVersion: 1,
    })
    await syncCursorUpsert(tx, { connectionId: connection.id, resourceType: 'gmail.history', cursor: '1', status: 'synced' })
    return connection.id
  })
}

const get = (id: string) => withService(env.t.db, (tx) => connectionGet(tx, id))
const events = () =>
  env.t.db<{ kind: string; revokeOutcome: string | null }[]>`
    select kind, revoke_outcome from public.connection_events order by created_at, id`
async function counts(id: string) {
  const [row] = await env.t.db<{ tokens: number; cursors: number }[]>`
    select (select count(*)::int from private.connection_tokens where connection_id = ${id}) as tokens,
           (select count(*)::int from public.sync_cursors where connection_id = ${id}) as cursors`
  return row!
}

describe('connection admin', () => {
  it('pause keeps tokens and stops jobs; resume brings it back; both are recorded once', async () => {
    const id = await seed('google', 'a')
    const paused = await connectionAdminPause(env.t.db, id, clock)
    expect(paused).toMatchObject({ status: 'paused', nextAttemptAt: null })
    expect(paused!.pausedAt).toEqual(clock)
    await connectionAdminPause(env.t.db, id, clock) // idempotent
    expect((await counts(id)).tokens).toBe(1)
    const resumed = await connectionAdminResume(env.t.db, id, clock)
    expect(resumed).toMatchObject({ status: 'connected', pausedAt: null })
    expect((await events()).map((e) => e.kind)).toEqual(['paused', 'resumed'])
    expect(await connectionAdminPause(env.t.db, '00000000-0000-4000-8000-000000000000', clock)).toBeNull()
  })

  it('rename trims and records', async () => {
    const id = await seed('google', 'b')
    expect((await connectionAdminRename(env.t.db, id, '  Work mail  '))?.accountLabel).toBe('Work mail')
    expect((await events()).map((e) => e.kind)).toEqual(['renamed'])
  })

  it('Google disconnect revokes the refresh token, then deletes tokens, cursors and the row', async () => {
    const id = await seed('google', 'c')
    const fake = providerFetch(() => clock)
    const result = await connectionAdminDisconnect({ db: env.t.db, id, key: env.key, fetch: fake.fetch, now: () => clock })
    expect(result).toEqual({ provider: 'google', accountLabel: 'c@example.com', revoke: 'revoked' })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.url).toBe(GOOGLE_REVOKE_URL)
    expect(new URLSearchParams(fake.calls[0]!.body).get('token')).toBe('refresh-c')
    expect(await get(id)).toBeNull()
    expect(await counts(id)).toEqual({ tokens: 0, cursors: 0 })
    expect(await events()).toEqual([{ kind: 'disconnected', revokeOutcome: 'revoked' }])
  })

  it('a failed or impossible revoke still disconnects, and says so', async () => {
    const g = await seed('google', 'd')
    const down = providerFetch(() => clock, { googleRevoke: () => new Response('', { status: 503 }) })
    expect((await connectionAdminDisconnect({ db: env.t.db, id: g, key: env.key, fetch: down.fetch, now: () => clock }))?.revoke).toBe('failed')
    expect(await get(g)).toBeNull()

    const gone = await seed('google', 'e')
    const invalid = providerFetch(() => clock, {
      googleRevoke: () => new Response(JSON.stringify({ error: 'invalid_token' }), { status: 400 }),
    })
    expect((await connectionAdminDisconnect({ db: env.t.db, id: gone, key: env.key, fetch: invalid.fetch, now: () => clock }))?.revoke).toBe('already_invalid')

    const noKey = await seed('google', 'f')
    const unused = providerFetch(() => clock)
    expect((await connectionAdminDisconnect({ db: env.t.db, id: noKey, key: null, fetch: unused.fetch, now: () => clock }))?.revoke).toBe('failed')
    expect(await get(noKey)).toBeNull()

    const ms = await seed('microsoft', 'g')
    const none = providerFetch(() => clock)
    expect((await connectionAdminDisconnect({ db: env.t.db, id: ms, key: env.key, fetch: none.fetch, now: () => clock }))?.revoke).toBe('not_supported')
    expect(none.calls).toHaveLength(0)
    expect(unused.calls).toHaveLength(0)
    expect((await events()).map((e) => e.revokeOutcome)).toEqual(['failed', 'already_invalid', 'failed', 'not_supported'])
  })

  it('disconnecting one account leaves the others alone', async () => {
    const keep = await seed('google', 'keep')
    const drop = await seed('google', 'drop')
    await connectionAdminDisconnect({ db: env.t.db, id: drop, key: env.key, fetch: providerFetch(() => clock).fetch, now: () => clock })
    expect((await get(keep))?.status).toBe('connected')
    expect(await counts(keep)).toEqual({ tokens: 1, cursors: 1 })
  })
})

describe('server actions', () => {
  const form = (fields: Record<string, string>) => {
    const f = new FormData()
    for (const [k, v] of Object.entries(fields)) f.set(k, v)
    return f
  }

  it('refuse requests without a same-origin Origin header', async () => {
    const { pauseConnection, disconnectConnection } = await import('@/app/(app)/settings/connections/actions')
    const id = await seed('google', 'h')
    for (const origin of [null, 'https://evil.example', 'null', `${APP_URL}.evil.example`]) {
      request.origin = origin
      await expect(pauseConnection(form({ id }))).rejects.toThrow('did not come from this app')
      await expect(disconnectConnection(form({ id, confirm: 'yes' }))).rejects.toThrow('did not come from this app')
    }
    expect((await get(id))?.status).toBe('connected')
  })

  it('require the owner', async () => {
    const { resumeConnection } = await import('@/app/(app)/settings/connections/actions')
    request.owner = false
    await expect(resumeConnection(form({ id: '00000000-0000-4000-8000-000000000000' }))).rejects.toThrow()
  })

  it('pause, resume and rename validate their input', async () => {
    const { pauseConnection, resumeConnection, renameConnection } = await import(
      '@/app/(app)/settings/connections/actions'
    )
    const id = await seed('microsoft', 'i')
    await pauseConnection(form({ id: 'not-a-uuid' }))
    expect((await get(id))?.status).toBe('connected')
    await pauseConnection(form({ id }))
    expect((await get(id))?.status).toBe('paused')
    await resumeConnection(form({ id }))
    expect((await get(id))?.status).toBe('connected')
    await renameConnection(form({ id, label: 'bad\u0007label' }))
    expect((await get(id))?.accountLabel).toBe('i@example.com')
    await renameConnection(form({ id, label: 'Outlook (work)' }))
    expect((await get(id))?.accountLabel).toBe('Outlook (work)')
    expect(request.revalidated.every((p) => p === '/settings/connections')).toBe(true)
  })

  it('disconnect needs the confirm step, then redirects with closed result flags', async () => {
    const { disconnectConnection } = await import('@/app/(app)/settings/connections/actions')
    const id = await seed('microsoft', 'j')
    await disconnectConnection(form({ id }))
    expect(await get(id)).not.toBeNull()
    expect(request.redirects).toEqual([])

    await expect(disconnectConnection(form({ id, confirm: 'yes' }))).rejects.toThrow('NEXT_REDIRECT')
    expect(await get(id)).toBeNull()
    expect(request.redirects).toEqual(['/settings/connections?disconnected=microsoft&revoke=not_supported'])
  })
})
