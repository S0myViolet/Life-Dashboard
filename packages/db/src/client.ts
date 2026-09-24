/**
 * Postgres access for Personal Home.
 *
 * Two ways in, and only two:
 *   - `withOwner`  — user-facing reads/writes. Runs the transaction as the
 *                    `authenticated` role with the owner's verified JWT claims,
 *                    so Row Level Security is enforced exactly as it would be
 *                    through the Supabase API.
 *   - `withService` — background jobs and trusted server flows (OAuth callbacks,
 *                    capture ingestion after token verification). Runs as the
 *                    connection role, which bypasses RLS. Callers must have
 *                    authenticated the request by other means first.
 *
 * Works in Node (Next.js server) and Deno (Supabase Edge Functions).
 */
import postgres from 'postgres'

export type Db = postgres.Sql
export type Tx = postgres.TransactionSql

export interface OwnerClaims {
  /** Supabase auth user id (JWT `sub`), already verified by the caller. */
  sub: string
  email?: string | null
}

export interface CreateDbOptions {
  /** Pool size. Serverless functions should keep this small. */
  max?: number
  applicationName?: string
  /** Seconds before an idle connection is closed. */
  idleTimeout?: number
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

export function createDb(url: string, options: CreateDbOptions = {}): Db {
  return postgres(url, {
    // Required for the Supabase transaction pooler (port 6543).
    prepare: false,
    max: options.max ?? 5,
    idle_timeout: options.idleTimeout ?? 20,
    connect_timeout: 10,
    connection: { application_name: options.applicationName ?? 'personal-home' },
    onnotice: () => {},
    transform: { ...postgres.camel, undefined: null },
    types: {
      // Local calendar dates stay as 'YYYY-MM-DD' strings. Parsing them into a
      // JS Date would shift them across timezones.
      date: {
        to: 1082,
        from: [1082],
        serialize: (x: string) => x,
        parse: (x: string) => x,
      },
      // count(*) and minor-unit money amounts come back as numbers, but never lossy.
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number | bigint) => x.toString(),
        parse: (x: string) => {
          const n = BigInt(x)
          if (n > MAX_SAFE || n < -MAX_SAFE) {
            throw new RangeError(`bigint ${x} exceeds Number.MAX_SAFE_INTEGER`)
          }
          return Number(n)
        },
      },
    },
  })
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Run `fn` inside a transaction as the `authenticated` role with the given
 * verified claims. RLS policies (public.is_owner()) decide what is visible.
 */
export async function withOwner<T>(
  db: Db,
  claims: OwnerClaims,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(claims.sub)) {
    throw new Error('withOwner requires a verified user id')
  }
  const jwtClaims = JSON.stringify({
    sub: claims.sub,
    email: claims.email ?? null,
    role: 'authenticated',
  })
  const result = await db.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${jwtClaims}, true), set_config('role', 'authenticated', true)`
    return fn(tx)
  })
  return result as T
}

/** Run `fn` in a transaction as the trusted server role (bypasses RLS). */
export async function withService<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const result = await db.begin(async (tx) => fn(tx))
  return result as T
}
