/**
 * public.hook_before_user_created — Supabase "Before User Created" auth hook.
 *
 * Payloads below are SYNTHETIC FIXTURES (not captured from the live service),
 * shaped from the documented contract in docs/research/supabase.md (Q10):
 * { metadata: { uuid, time, ip_address, name }, user: { id, email, phone,
 *   app_metadata: { provider, providers }, user_metadata, aud, role, is_anonymous } }.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureOwnerAllowlisted, removeOwnerAllowlisted, withService } from '../src/index.ts'
import {
  createAuthUser,
  createTestDatabase,
  withAnon,
  withOwner,
  type TestDatabase,
} from './harness.ts'

// SYNTHETIC FIXTURE (not captured from the live service)
function event(
  user: Partial<{
    email: unknown
    provider: unknown
    is_anonymous: unknown
  }> = {},
) {
  return {
    metadata: {
      uuid: '8b34dcdd-9df1-4c10-850a-b3277c653040',
      time: '2026-09-24T12:00:00Z',
      ip_address: '203.0.113.7',
      name: 'before-user-created',
    },
    user: {
      id: 'ff7fc9ae-3b1b-4642-9241-64adb9848a03',
      aud: 'authenticated',
      role: '',
      email: 'email' in user ? user.email : 'owner@example.com',
      phone: '',
      app_metadata: {
        provider: 'provider' in user ? user.provider : 'google',
        providers: ['google'],
      },
      user_metadata: { full_name: 'Owner', email_verified: true },
      is_anonymous: 'is_anonymous' in user ? user.is_anonymous : false,
    },
  }
}

const REJECT = {
  error: {
    http_code: 403,
    message: 'This is a private dashboard. Sign-up is not available for this account.',
  },
}

let t: TestDatabase

// Read the result as text: the shared client camelCases jsonb keys (http_code → httpCode),
// and the exact key names are the contract with Supabase Auth.
async function callHook(payload: unknown): Promise<unknown> {
  const [row] = await t.db<{ result: string }[]>`
    select public.hook_before_user_created(${t.db.json(payload as never)})::text as result
  `
  return row ? JSON.parse(row.result) : undefined
}

beforeAll(async () => {
  t = await createTestDatabase()
  await withService(t.db, (tx) => ensureOwnerAllowlisted(tx, '  Owner@Example.com '))
})
afterAll(async () => {
  await t?.drop()
})

describe('hook_before_user_created', () => {
  it('allows an allowlisted Google sign-up (email compared case-insensitively)', async () => {
    expect(await callHook(event())).toEqual({})
    expect(await callHook(event({ email: 'OWNER@example.COM ' }))).toEqual({})
  })

  it('rejects strangers with the documented 403 error shape', async () => {
    expect(await callHook(event({ email: 'stranger@example.com' }))).toEqual(REJECT)
    expect(await callHook(event({ email: 'owner@example.com.evil.test' }))).toEqual(REJECT)
    expect(await callHook(event({ email: 'owner@example.co' }))).toEqual(REJECT)
  })

  it('rejects non-Google providers, anonymous users and missing emails', async () => {
    expect(await callHook(event({ provider: 'email' }))).toEqual(REJECT)
    expect(await callHook(event({ provider: 'github' }))).toEqual(REJECT)
    expect(await callHook(event({ provider: null }))).toEqual(REJECT)
    expect(await callHook(event({ is_anonymous: true }))).toEqual(REJECT)
    expect(await callHook(event({ email: '' }))).toEqual(REJECT)
    expect(await callHook(event({ email: null }))).toEqual(REJECT)
    expect(await callHook(event({ email: ['owner@example.com'] }))).toEqual(REJECT)
  })

  it('fails closed on malformed events', async () => {
    for (const payload of [{}, { user: null }, { user: 'owner@example.com' }, [], 'x', null]) {
      expect(await callHook(payload)).toEqual(REJECT)
    }
  })

  it('fails closed when the allowlist is empty', async () => {
    await withService(t.db, (tx) => removeOwnerAllowlisted(tx, 'owner@example.com'))
    try {
      expect(await callHook(event())).toEqual(REJECT)
    } finally {
      await withService(t.db, (tx) => ensureOwnerAllowlisted(tx, 'owner@example.com'))
    }
    expect(await callHook(event())).toEqual({})
  })

  it('never creates an auth.users row itself', async () => {
    const [before] = await t.db<{ n: number }[]>`select count(*)::int as n from auth.users`
    await callHook(event())
    await callHook(event({ email: 'stranger@example.com' }))
    const [after] = await t.db<{ n: number }[]>`select count(*)::int as n from auth.users`
    expect(after?.n).toBe(before?.n)
  })
})

describe('hook permissions', () => {
  it('anon, authenticated and service_role cannot execute it', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const [row] = await t.db<{ ok: boolean }[]>`
        select has_function_privilege(${role}, 'public.hook_before_user_created(jsonb)', 'execute') as ok
      `
      expect(row?.ok, role).toBe(false)
    }
    // No EXECUTE grant to PUBLIC (grantee oid 0) in the ACL.
    const [publicGrant] = await t.db<{ ok: boolean }[]>`
      select coalesce(bool_or(a.grantee = 0), false) as ok
      from pg_proc p, aclexplode(p.proacl) a
      where p.oid = 'public.hook_before_user_created(jsonb)'::regprocedure
        and a.privilege_type = 'EXECUTE'
    `
    expect(publicGrant?.ok).toBe(false)
    const stranger = await createAuthUser(t.db, 'stranger@example.com')
    await expect(
      withOwner(t.db, stranger, (tx) => tx`select public.hook_before_user_created('{}'::jsonb)`),
    ).rejects.toThrow(/permission denied/)
    await expect(
      withAnon(t.db, (tx) => tx`select public.hook_before_user_created('{}'::jsonb)`),
    ).rejects.toThrow(/permission denied/)
  })

  it('works for a low-privilege role like supabase_auth_admin (security definer)', async () => {
    // Roles are cluster-wide, so create a throwaway role inside a transaction and roll it back.
    const role = `ph_test_auth_admin_${Math.random().toString(36).slice(2, 10)}`
    const outcome = await t.db
      .begin(async (tx) => {
        await tx.unsafe(`create role ${role} nologin noinherit`)
        await tx.unsafe(
          `grant execute on function public.hook_before_user_created(jsonb) to ${role}`,
        )
        await tx.unsafe(`set local role ${role}`)
        const [allowed] = await tx<{ r: string }[]>`
          select public.hook_before_user_created(${tx.json(event() as never)})::text as r
        `
        const [rejected] = await tx<{ r: string }[]>`
          select public.hook_before_user_created(${tx.json(event({ email: 'x@y.z' }) as never)})::text as r
        `
        // The role itself still cannot read the allowlist.
        const direct = await tx
          .savepoint((sp) => sp`select * from private.owner_allowlist`)
          .then(
            () => 'readable',
            (e: Error) => e.message,
          )
        throw Object.assign(new Error('rollback'), {
          result: {
            allowed: JSON.parse(allowed!.r) as unknown,
            rejected: JSON.parse(rejected!.r) as unknown,
            direct,
          },
        })
      })
      .catch((e: Error & { result?: unknown }) => {
        if (!e.result) throw e
        return e.result as { allowed: unknown; rejected: unknown; direct: string }
      })
    expect(outcome.allowed).toEqual({})
    expect(outcome.rejected).toEqual(REJECT)
    expect(outcome.direct).toMatch(/permission denied/)
    const [leftover] = await t.db`select 1 from pg_roles where rolname = ${role}`
    expect(leftover).toBeUndefined()
  })
})

describe('owner allowlist', () => {
  it('normalises addresses, validates them and is private to the server', async () => {
    const stored = await withService(t.db, (tx) => ensureOwnerAllowlisted(tx, 'Second@Example.org'))
    expect(stored).toBe('second@example.org')
    // Idempotent.
    await withService(t.db, (tx) => ensureOwnerAllowlisted(tx, 'second@example.org'))
    const rows = await t.db<
      { email: string }[]
    >`select email from private.owner_allowlist order by 1`
    expect(rows.map((r) => r.email)).toEqual(['owner@example.com', 'second@example.org'])
    await expect(
      withService(t.db, (tx) => ensureOwnerAllowlisted(tx, 'not-an-email')),
    ).rejects.toThrow()
    // The table itself rejects un-normalised rows written by hand.
    await expect(
      t.db`insert into private.owner_allowlist (email) values ('Mixed@Example.com')`,
    ).rejects.toThrow(/check constraint/)
    const stranger = await createAuthUser(t.db, 'someone@example.com')
    await expect(
      withOwner(t.db, stranger, (tx) => tx`select * from private.owner_allowlist`),
    ).rejects.toThrow(/permission denied/)
    await expect(withAnon(t.db, (tx) => tx`select * from private.owner_allowlist`)).rejects.toThrow(
      /permission denied/,
    )
    expect(await withService(t.db, (tx) => removeOwnerAllowlisted(tx, 'second@example.org'))).toBe(
      true,
    )
  })
})
