import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectionFailure } from '@personal-home/core'
import {
  connectionApplyEvent,
  connectionDelete,
  connectionEventRecord,
  connectionEventsRecent,
  connectionGet,
  connectionOAuthStateConsume,
  connectionOAuthStateCreate,
  connectionRename,
  connectionsDue,
  connectionsList,
  connectionTokensGet,
  connectionTokensRotate,
  connectionTokensSave,
  connectionUpsertAuthorized,
  syncCursorsList,
  syncCursorUpsert,
  withOwner,
  withService,
  type OwnerClaims,
} from '../src/index.ts'
import {
  createAuthUser,
  createTestDatabase,
  seedOwner,
  withAnon,
  type TestDatabase,
} from './harness.ts'

let t: TestDatabase
let owner: OwnerClaims
let stranger: OwnerClaims

const at = new Date('2026-09-24T10:00:00Z')
const ENV = 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBB'
const ENV2 = 'v1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDDDD'
const hash = (c: string) => c.repeat(64)

beforeAll(async () => {
  t = await createTestDatabase()
  owner = await seedOwner(t.db)
  stranger = await createAuthUser(t.db, 'stranger@example.com')
})
afterAll(async () => {
  await t?.drop()
})

async function connect(externalAccountId: string, provider: 'google' | 'microsoft' = 'google') {
  return withService(t.db, async (tx) => {
    const r = await connectionUpsertAuthorized(tx, {
      provider,
      externalAccountId,
      accountLabel: `${externalAccountId}@example.com`,
      grantedScopes: ['openid', 'email'],
      at,
    })
    await connectionTokensSave(tx, {
      connectionId: r.connection.id,
      refreshTokenCiphertext: ENV,
      accessTokenCiphertext: ENV,
      accessTokenExpiresAt: at,
      keyVersion: 1,
    })
    return r
  })
}

describe('connections access control', () => {
  it('owner reads connections, cursors and events; strangers see nothing; anon is refused', async () => {
    const { connection } = await connect('acl-1')
    await withService(t.db, async (tx) => {
      await syncCursorUpsert(tx, {
        connectionId: connection.id,
        resourceType: 'gmail.history',
        cursor: '1',
        status: 'synced',
      })
      await connectionEventRecord(tx, {
        connectionId: connection.id,
        provider: 'google',
        accountLabel: 'x',
        kind: 'connected',
      })
    })

    const mine = await withOwner(t.db, owner, (tx) => connectionsList(tx))
    expect(mine.map((c) => c.id)).toContain(connection.id)
    expect(await withOwner(t.db, owner, (tx) => syncCursorsList(tx, connection.id))).toHaveLength(1)
    expect(
      (await withOwner(t.db, owner, (tx) => connectionEventsRecent(tx))).length,
    ).toBeGreaterThan(0)

    expect(await withOwner(t.db, stranger, (tx) => connectionsList(tx))).toEqual([])
    expect(await withOwner(t.db, stranger, (tx) => syncCursorsList(tx, connection.id))).toEqual([])
    expect(await withOwner(t.db, stranger, (tx) => connectionEventsRecent(tx))).toEqual([])

    for (const table of ['public.connections', 'public.sync_cursors', 'public.connection_events']) {
      await expect(withAnon(t.db, (tx) => tx.unsafe(`select * from ${table}`))).rejects.toThrow(
        /permission denied/,
      )
    }
  })

  it('the owner cannot write connection state directly (server code only)', async () => {
    const { connection } = await connect('acl-2')
    await expect(
      withOwner(
        t.db,
        owner,
        (tx) => tx`update public.connections set status = 'connected' where id = ${connection.id}`,
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      withOwner(
        t.db,
        owner,
        (tx) =>
          tx`insert into public.connections (provider, account_label, external_account_id) values ('google', 'x', 'y')`,
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      withOwner(
        t.db,
        owner,
        (tx) => tx`delete from public.connections where id = ${connection.id}`,
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      withOwner(t.db, owner, (tx) => tx`update public.sync_cursors set cursor = 'x'`),
    ).rejects.toThrow(/permission denied/)
    await expect(
      withOwner(t.db, owner, (tx) => tx`delete from public.connection_events`),
    ).rejects.toThrow(/permission denied/)
  })

  it('tokens and OAuth states are unreachable for owner and anon', async () => {
    for (const table of ['private.connection_tokens', 'private.oauth_states']) {
      await expect(
        withOwner(t.db, owner, (tx) => tx.unsafe(`select * from ${table}`)),
      ).rejects.toThrow(/permission denied/)
      await expect(withAnon(t.db, (tx) => tx.unsafe(`select * from ${table}`))).rejects.toThrow(
        /permission denied/,
      )
    }
    const [grants] = await t.db<{ n: number }[]>`
      select count(*)::int as n from information_schema.role_table_grants
      where table_schema = 'private' and table_name in ('connection_tokens', 'oauth_states')
        and grantee in ('anon', 'authenticated', 'PUBLIC')`
    expect(grants?.n).toBe(0)
  })
})

describe('connections constraints', () => {
  it('rejects unknown providers/statuses, inconsistent pause, malformed codes and duplicate accounts', async () => {
    const bad = [
      `insert into public.connections (provider, account_label, external_account_id) values ('myspace', 'x', 'y')`,
      `insert into public.connections (provider, account_label, external_account_id, status) values ('google', 'x', 'y1', 'needs_setup')`,
      `insert into public.connections (provider, account_label, external_account_id, status) values ('google', 'x', 'y2', 'paused')`,
      `insert into public.connections (provider, account_label, external_account_id, paused_at) values ('google', 'x', 'y3', now())`,
      `insert into public.connections (provider, account_label, external_account_id, last_error_code) values ('google', 'x', 'y4', 'Not A Code')`,
      `insert into public.connections (provider, account_label, external_account_id) values ('google', '', 'y5')`,
    ]
    for (const sql of bad) await expect(t.db.unsafe(sql)).rejects.toThrow(/violates/)
    await connect('dup-1')
    await expect(
      t.db`insert into public.connections (provider, account_label, external_account_id) values ('google', 'x', 'dup-1')`,
    ).rejects.toThrow(/duplicate key/)
    // Same external id under another provider is a different account.
    await connect('dup-1', 'microsoft')
  })

  it('tokens must be encryption envelopes; states must be hashed with a safe return path', async () => {
    const { connection } = await connect('env-1')
    await expect(
      t.db`update private.connection_tokens set refresh_token_ciphertext = 'plaintext-token' where connection_id = ${connection.id}`,
    ).rejects.toThrow(/violates/)
    await expect(
      withService(t.db, (tx) =>
        connectionOAuthStateCreate(tx, {
          stateHash: 'raw-state',
          provider: 'google',
          codeVerifierCiphertext: ENV,
          returnTo: '/settings/connections',
        }),
      ),
    ).rejects.toThrow(/violates/)
    for (const returnTo of ['//evil.example', 'https://evil.example', '/settings?x=1', '/a//b']) {
      await expect(
        withService(t.db, (tx) =>
          connectionOAuthStateCreate(tx, {
            stateHash: hash('e'),
            provider: 'google',
            codeVerifierCiphertext: ENV,
            returnTo,
          }),
        ),
      ).rejects.toThrow(/violates/)
    }
  })
})

describe('authorised connections', () => {
  it('creates once, then reconnects the same account keeping the owner label and pause', async () => {
    const first = await connect('re-1')
    expect(first.created).toBe(true)
    expect(first.connection).toMatchObject({
      status: 'connected',
      lastSuccessAt: at,
      grantedScopes: ['openid', 'email'],
    })

    await withService(t.db, async (tx) => {
      await connectionRename(tx, first.connection.id, 'Work Gmail')
      await connectionApplyEvent(tx, first.connection.id, {
        type: 'attempt_failed',
        at,
        failure: connectionFailure('auth', 'invalid_grant', 'x'),
      })
    })
    const later = new Date(at.getTime() + 3600_000)
    const again = await withService(t.db, (tx) =>
      connectionUpsertAuthorized(tx, {
        provider: 'google',
        externalAccountId: 're-1',
        accountLabel: 're-1@example.com',
        grantedScopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
        at: later,
      }),
    )
    expect(again.created).toBe(false)
    expect(again.connection).toMatchObject({
      id: first.connection.id,
      accountLabel: 'Work Gmail',
      status: 'connected',
      lastErrorCode: null,
      consecutiveFailures: 0,
      lastSuccessAt: later,
    })
    expect(again.connection.grantedScopes).toContain(
      'https://www.googleapis.com/auth/gmail.readonly',
    )

    await withService(t.db, (tx) =>
      connectionApplyEvent(tx, first.connection.id, { type: 'paused', at: later }),
    )
    const whilePaused = await withService(t.db, (tx) =>
      connectionUpsertAuthorized(tx, {
        provider: 'google',
        externalAccountId: 're-1',
        accountLabel: 'x',
        grantedScopes: ['openid'],
        at: later,
      }),
    )
    expect(whilePaused.connection.status).toBe('paused')
  })

  it('a job outcome that lands after the owner paused never un-pauses', async () => {
    const { connection } = await connect('race-1')
    await withService(t.db, (tx) => connectionApplyEvent(tx, connection.id, { type: 'paused', at }))
    const after = await withService(t.db, (tx) =>
      connectionApplyEvent(tx, connection.id, {
        type: 'attempt_succeeded',
        at: new Date(at.getTime() + 1000),
      }),
    )
    expect(after).toMatchObject({ status: 'paused', lastSuccessAt: new Date(at.getTime() + 1000) })
    expect(
      await withService(t.db, (tx) =>
        connectionApplyEvent(tx, '00000000-0000-0000-0000-000000000000', { type: 'paused', at }),
      ),
    ).toBeNull()
  })

  it('stores sanitised error messages', async () => {
    const { connection } = await connect('msg-1')
    const row = await withService(t.db, (tx) =>
      connectionApplyEvent(tx, connection.id, {
        type: 'attempt_failed',
        at,
        failure: {
          kind: 'transient',
          code: 'transient.unexpected',
          message: 'Bearer ya29.leak for a@b.com',
        },
      }),
    )
    expect(row?.lastErrorMessage).toBe('Bearer [redacted] for [email]')
    expect(row?.status).toBe('error')
  })

  it('lists due connections only (not paused, not awaiting reconnect, next attempt reached)', async () => {
    const t2 = await createTestDatabase()
    try {
      const mk = (id: string) =>
        withService(t2.db, (tx) =>
          connectionUpsertAuthorized(tx, {
            provider: 'microsoft',
            externalAccountId: id,
            accountLabel: id,
            grantedScopes: [],
            at,
          }),
        )
      const a = await mk('due-a')
      const b = await mk('due-b')
      const c = await mk('due-c')
      const d = await mk('due-d')
      await withService(t2.db, async (tx) => {
        await connectionApplyEvent(tx, b.connection.id, { type: 'paused', at })
        await connectionApplyEvent(tx, c.connection.id, {
          type: 'attempt_failed',
          at,
          failure: connectionFailure('auth', 'invalid_grant', 'x'),
        })
        await connectionApplyEvent(tx, d.connection.id, {
          type: 'attempt_failed',
          at,
          failure: connectionFailure('rate_limited', 'http_429', 'x', { retryAfterMs: 600_000 }),
        })
      })
      const ids = async (when: Date) =>
        (await withService(t2.db, (tx) => connectionsDue(tx, 'microsoft', when))).map((r) => r.id)
      expect(await ids(new Date(at.getTime() + 60_000))).toEqual([a.connection.id])
      expect((await ids(new Date(at.getTime() + 600_000))).sort()).toEqual(
        [a.connection.id, d.connection.id].sort(),
      )
      expect(await withService(t2.db, (tx) => connectionsDue(tx, 'google', at))).toEqual([])
    } finally {
      await t2.drop()
    }
  })
})

describe('connection tokens', () => {
  it('rotation updates atomically and keeps the stored refresh token when none was returned', async () => {
    const { connection } = await connect('tok-1')
    const exp = new Date(at.getTime() + 3600_000)
    expect(
      await withService(t.db, (tx) =>
        connectionTokensRotate(tx, {
          connectionId: connection.id,
          accessTokenCiphertext: ENV2,
          accessTokenExpiresAt: exp,
          refreshTokenCiphertext: null,
          keyVersion: 1,
        }),
      ),
    ).toBe(true)
    let row = await withService(t.db, (tx) => connectionTokensGet(tx, connection.id))
    expect(row).toMatchObject({
      refreshTokenCiphertext: ENV,
      accessTokenCiphertext: ENV2,
      accessTokenExpiresAt: exp,
    })

    await withService(t.db, (tx) =>
      connectionTokensRotate(tx, {
        connectionId: connection.id,
        accessTokenCiphertext: ENV,
        accessTokenExpiresAt: exp,
        refreshTokenCiphertext: ENV2,
        keyVersion: 1,
      }),
    )
    row = await withService(t.db, (tx) => connectionTokensGet(tx, connection.id))
    expect(row).toMatchObject({ refreshTokenCiphertext: ENV2 })
  })

  it('skip_locked reports busy while another transaction refreshes', async () => {
    const { connection } = await connect('tok-2')
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let locked!: () => void
    const isLocked = new Promise<void>((r) => (locked = r))
    const holder = withService(t.db, async (tx) => {
      const r = await connectionTokensGet(tx, connection.id, 'skip_locked')
      expect(r).not.toBe('busy')
      locked()
      await held
    })
    await isLocked
    expect(
      await withService(t.db, (tx) => connectionTokensGet(tx, connection.id, 'skip_locked')),
    ).toBe('busy')
    release()
    await holder
    expect(
      await withService(t.db, (tx) => connectionTokensGet(tx, connection.id, 'skip_locked')),
    ).not.toBe('busy')
    expect(
      await withService(t.db, (tx) =>
        connectionTokensGet(tx, '00000000-0000-0000-0000-000000000000', 'skip_locked'),
      ),
    ).toBeNull()
  })

  it('disconnect deletes tokens, cursors and the row; a late rotation does not resurrect it', async () => {
    const { connection } = await connect('del-1')
    await withService(t.db, (tx) =>
      syncCursorUpsert(tx, {
        connectionId: connection.id,
        resourceType: 'gcal.events',
        resourceId: 'primary',
        cursor: 'tok',
        status: 'synced',
      }),
    )
    const deleted = await withService(t.db, (tx) => connectionDelete(tx, connection.id))
    expect(deleted?.id).toBe(connection.id)
    expect(await withService(t.db, (tx) => connectionGet(tx, connection.id))).toBeNull()
    expect(await withService(t.db, (tx) => connectionTokensGet(tx, connection.id))).toBeNull()
    expect(await withService(t.db, (tx) => syncCursorsList(tx, connection.id))).toEqual([])
    expect(
      await withService(t.db, (tx) =>
        connectionTokensRotate(tx, {
          connectionId: connection.id,
          accessTokenCiphertext: ENV,
          accessTokenExpiresAt: null,
          refreshTokenCiphertext: ENV,
          keyVersion: 1,
        }),
      ),
    ).toBe(false)
    expect(await withService(t.db, (tx) => connectionDelete(tx, connection.id))).toBeNull()
  })
})

describe('OAuth states', () => {
  it('are single use, provider-bound and expire', async () => {
    await withService(t.db, (tx) =>
      connectionOAuthStateCreate(tx, {
        stateHash: hash('a'),
        provider: 'google',
        codeVerifierCiphertext: ENV,
        returnTo: '/settings/connections',
      }),
    )
    expect(
      await withService(t.db, (tx) =>
        connectionOAuthStateConsume(tx, { stateHash: hash('a'), provider: 'microsoft' }),
      ),
    ).toBeNull()
    expect(
      await withService(t.db, (tx) =>
        connectionOAuthStateConsume(tx, { stateHash: hash('a'), provider: 'google' }),
      ),
    ).toEqual({
      codeVerifierCiphertext: ENV,
      returnTo: '/settings/connections',
    })
    expect(
      await withService(t.db, (tx) =>
        connectionOAuthStateConsume(tx, { stateHash: hash('a'), provider: 'google' }),
      ),
    ).toBeNull()

    await withService(t.db, (tx) =>
      connectionOAuthStateCreate(tx, {
        stateHash: hash('b'),
        provider: 'google',
        codeVerifierCiphertext: ENV,
        returnTo: '/',
      }),
    )
    await t.db`update private.oauth_states set created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' where state_hash = ${hash('b')}`
    expect(
      await withService(t.db, (tx) =>
        connectionOAuthStateConsume(tx, { stateHash: hash('b'), provider: 'google' }),
      ),
    ).toBeNull()
  })

  it('cannot be created with a TTL longer than 10 minutes, and old ones are purged', async () => {
    await expect(
      t.db`insert into private.oauth_states (state_hash, provider, code_verifier_ciphertext, return_to, expires_at)
           values (${hash('c')}, 'google', ${ENV}, '/', now() + interval '1 hour')`,
    ).rejects.toThrow(/violates/)
    await t.db`insert into private.oauth_states (state_hash, provider, code_verifier_ciphertext, return_to, created_at, expires_at)
               values (${hash('d')}, 'google', ${ENV}, '/', now() - interval '3 days', now() - interval '3 days' + interval '10 minutes')`
    await withService(t.db, (tx) =>
      connectionOAuthStateCreate(tx, {
        stateHash: hash('f'),
        provider: 'microsoft',
        codeVerifierCiphertext: ENV,
        returnTo: '/',
      }),
    )
    const [left] = await t.db<
      { n: number }[]
    >`select count(*)::int as n from private.oauth_states where state_hash = ${hash('d')}`
    expect(left?.n).toBe(0)
  })
})

describe('sync cursors', () => {
  it('upserts one cursor per connection/resource and validates windows', async () => {
    const { connection } = await connect('cur-1')
    const a = await withService(t.db, (tx) =>
      syncCursorUpsert(tx, {
        connectionId: connection.id,
        resourceType: 'graph.messages',
        resourceId: 'inbox',
        cursor: 'd1',
        status: 'partial',
      }),
    )
    const b = await withService(t.db, (tx) =>
      syncCursorUpsert(tx, {
        connectionId: connection.id,
        resourceType: 'graph.messages',
        resourceId: 'inbox',
        cursor: 'd2',
        status: 'synced',
        lastSyncedAt: at,
      }),
    )
    expect(b.id).toBe(a.id)
    expect(b).toMatchObject({ cursor: 'd2', status: 'synced', lastSyncedAt: at })
    await expect(
      withService(t.db, (tx) =>
        syncCursorUpsert(tx, {
          connectionId: connection.id,
          resourceType: 'graph.calendar_view',
          cursor: null,
          status: 'pending',
          windowStart: at,
          windowEnd: new Date(at.getTime() - 1),
        }),
      ),
    ).rejects.toThrow(/violates/)
  })
})
