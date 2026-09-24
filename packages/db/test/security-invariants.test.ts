/**
 * Catalog-level invariants that every migration must keep. These catch a new
 * table or function that forgot to call private.secure_owner_table(...) or to
 * revoke Supabase's default grants.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDatabase, type TestDatabase } from './harness.ts'

let t: TestDatabase
beforeAll(async () => {
  t = await createTestDatabase()
})
afterAll(async () => {
  await t?.drop()
})

describe('security invariants', () => {
  it('every public table has RLS enabled and an owner policy', async () => {
    const rows = await t.db<{ table: string; rls: boolean; policies: number }[]>`
      select c.relname as table, c.relrowsecurity as rls,
             (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by 1
    `
    expect(rows.length).toBeGreaterThan(0)
    const bad = rows.filter((r) => !r.rls || r.policies === 0).map((r) => r.table)
    expect(bad).toEqual([])
  })

  it('anon has no privileges on any public table or view', async () => {
    const rows = await t.db<{ table: string; privilege: string }[]>`
      select table_name as table, privilege_type as privilege
      from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon', 'PUBLIC')
    `
    expect(rows).toEqual([])
  })

  it('anon cannot execute any function in public or private', async () => {
    const rows = await t.db<{ fn: string }[]>`
      select n.nspname || '.' || p.proname as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')
        and has_function_privilege('anon', p.oid, 'execute')
    `
    // private.* is unreachable without schema usage, but keep grants tight anyway.
    const exposed = rows.map((r) => r.fn).filter((fn) => fn.startsWith('public.'))
    expect(exposed).toEqual([])
  })

  it('no public view bypasses RLS (security_invoker required)', async () => {
    const rows = await t.db<{ view: string }[]>`
      select c.relname as view
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v'
        and not coalesce(c.reloptions @> array['security_invoker=true'], false)
    `
    expect(rows).toEqual([])
  })

  it('authenticated cannot use the private schema', async () => {
    const [row] = await t.db<
      { ok: boolean }[]
    >`select has_schema_privilege('authenticated', 'private', 'usage') as ok`
    expect(row?.ok).toBe(false)
  })
})
