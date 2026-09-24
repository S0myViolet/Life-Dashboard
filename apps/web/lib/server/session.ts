/**
 * Who is making this request, and are they the dashboard owner?
 *
 * Identity comes from Supabase Auth (JWT verified with getClaims()). Ownership
 * comes from the database (private.owner via public.is_owner()), so RLS and the
 * UI agree. Use `requireOwner()` in pages/server actions and `getOwner()` in
 * route handlers that must answer 401/403 instead of redirecting.
 */
import 'server-only'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { isOwner, type OwnerClaims, type Tx } from '@personal-home/db'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { ownerTransaction } from '@/lib/server/db'
import { decodeE2eSession, e2eAuthEnabled, E2E_COOKIE } from '@/lib/server/e2e-auth'

export interface OwnerSession {
  claims: OwnerClaims
  userId: string
  email: string | null
}

export type SessionState =
  | { status: 'signed_out' }
  | { status: 'not_owner'; claims: OwnerClaims }
  | { status: 'owner'; session: OwnerSession }

const getClaims = cache(async (): Promise<OwnerClaims | null> => {
  if (e2eAuthEnabled()) {
    const store = await cookies()
    return decodeE2eSession(store.get(E2E_COOKIE)?.value, process.env.PH_E2E_AUTH_SECRET!)
  }
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.auth.getClaims()
  if (error || !data?.claims?.sub) return null
  const email = typeof data.claims.email === 'string' ? data.claims.email : null
  return { sub: data.claims.sub, email }
})

export const getSessionState = cache(async (): Promise<SessionState> => {
  const claims = await getClaims()
  if (!claims) return { status: 'signed_out' }
  const owner = await ownerTransaction(claims, (tx) => isOwner(tx))
  if (!owner) return { status: 'not_owner', claims }
  return { status: 'owner', session: { claims, userId: claims.sub, email: claims.email ?? null } }
})

/** For pages, layouts and server actions: redirects when not the owner. */
export async function requireOwner(): Promise<OwnerSession> {
  const state = await getSessionState()
  if (state.status === 'signed_out') redirect('/login')
  if (state.status === 'not_owner') redirect('/not-authorized')
  return state.session
}

/** For route handlers: returns null instead of redirecting. */
export async function getOwner(): Promise<OwnerSession | null> {
  const state = await getSessionState()
  return state.status === 'owner' ? state.session : null
}

/** Run an owner-scoped (RLS-enforced) transaction for the current request. */
export async function withOwnerTx<T>(
  fn: (tx: Tx, session: OwnerSession) => Promise<T>,
): Promise<T> {
  const session = await requireOwner()
  return ownerTransaction(session.claims, (tx) => fn(tx, session))
}
