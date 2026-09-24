import 'server-only'
import {
  createDb,
  withOwner,
  withService,
  type Db,
  type OwnerClaims,
  type Tx,
} from '@personal-home/db'
import { coreEnv } from '@/lib/env'

const globalForDb = globalThis as unknown as { __phDb?: Db }

/** One small pool per server instance (survives dev hot reloads). */
export function getDb(): Db {
  if (!globalForDb.__phDb) {
    const url = process.env.DATABASE_URL ?? coreEnv().DATABASE_URL
    globalForDb.__phDb = createDb(url, { max: 3, applicationName: 'personal-home-web' })
  }
  return globalForDb.__phDb
}

export function ownerTransaction<T>(claims: OwnerClaims, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withOwner(getDb(), claims, fn)
}

/** Trusted server flows only (OAuth callbacks, verified capture ingestion). Bypasses RLS. */
export function serviceTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withService(getDb(), fn)
}
