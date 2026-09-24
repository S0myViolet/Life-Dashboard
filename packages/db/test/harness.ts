/**
 * Test helpers shared by database, job and web tests.
 *
 *   const t = await createTestDatabase()
 *   const owner = await seedOwner(t.db)
 *   await withOwner(t.db, owner, (tx) => tx`select ...`)
 *   await t.drop()
 */
import { randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { createDb, withOwner, type Db, type OwnerClaims, type Tx } from '../src/client.ts'
import { claimOwner } from '../src/owner.ts'

const PORT = Number(process.env.PH_PG_PORT ?? 54329)

export function serverUrl(db = 'postgres'): string {
  const base = process.env.TEST_DATABASE_URL
  if (base) {
    const u = new URL(base)
    u.pathname = `/${db}`
    return u.toString()
  }
  return `postgres://postgres@127.0.0.1:${PORT}/${db}`
}

export interface TestDatabase {
  name: string
  url: string
  db: Db
  drop(): Promise<void>
}

export async function createTestDatabase(template = 'ph_template'): Promise<TestDatabase> {
  const name = `ph_test_${randomBytes(6).toString('hex')}`
  const admin = postgres(serverUrl('postgres'), { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`create database ${name} template ${template}`)
  } finally {
    await admin.end()
  }
  const url = serverUrl(name)
  const db = createDb(url, { max: 10, applicationName: 'ph-test' })
  return {
    name,
    url,
    db,
    async drop() {
      await db.end({ timeout: 5 })
      const a = postgres(serverUrl('postgres'), { max: 1, onnotice: () => {} })
      try {
        await a.unsafe(`drop database if exists ${name} with (force)`)
      } finally {
        await a.end()
      }
    },
  }
}

/** Insert an auth user (as Supabase Auth would). Returns claims usable with withOwner. */
export async function createAuthUser(db: Db, email: string): Promise<OwnerClaims> {
  const id = randomUUID()
  await db`insert into auth.users (id, email, email_confirmed_at) values (${id}, ${email}, now())`
  return { sub: id, email }
}

/** Create an auth user and make them the dashboard owner. */
export async function seedOwner(db: Db, email = 'owner@example.com'): Promise<OwnerClaims> {
  const claims = await createAuthUser(db, email)
  const result = await db.begin((tx) => claimOwner(tx, claims.sub, email))
  if (result !== 'claimed') throw new Error(`seedOwner: expected claimed, got ${result}`)
  return claims
}

/** Run as the anonymous role (no JWT), like an unauthenticated Supabase API call. */
export async function withAnon<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const r = await db.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', '{"role":"anon"}', true), set_config('role', 'anon', true)`
    return fn(tx)
  })
  return r as T
}

export { withOwner }
