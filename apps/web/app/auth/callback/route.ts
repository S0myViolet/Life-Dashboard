import { NextResponse, type NextRequest } from 'next/server'
import { claimOwner, isOwner } from '@personal-home/db'
import { coreEnv } from '@/lib/env'
import { evaluateOwnerIdentity, safeNextPath } from '@/lib/auth/owner-identity'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'
import { ownerTransaction, serviceTransaction } from '@/lib/server/db'

export async function GET(request: NextRequest) {
  const env = coreEnv()
  const code = request.nextUrl.searchParams.get('code')
  const next = safeNextPath(request.nextUrl.searchParams.get('next'))
  const to = (path: string) => NextResponse.redirect(new URL(path, env.APP_URL))

  if (!code) return to('/login?error=missing_code')

  const supabase = await createSupabaseServerClient()
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
  if (exchangeError) return to('/login?error=exchange_failed')

  // getUser() asks the Auth server, so identities/email_verified are authoritative.
  const { data, error } = await supabase.auth.getUser()
  const user = data.user
  if (error || !user) return to('/login?error=no_user')

  const verdict = evaluateOwnerIdentity(user, env.OWNER_EMAIL)
  if (!verdict.allowed) {
    await supabase.auth.signOut()
    // Remove stray accounts so they do not accumulate, but never the recorded owner.
    const alreadyOwner = await ownerTransaction(
      { sub: user.id, email: user.email ?? null },
      isOwner,
    )
    if (!alreadyOwner) {
      await createSupabaseAdminClient()
        .auth.admin.deleteUser(user.id)
        .catch(() => undefined)
    }
    return to('/not-authorized')
  }

  const result = await serviceTransaction((tx) => claimOwner(tx, user.id, verdict.email))
  if (result === 'rejected') {
    await supabase.auth.signOut()
    return to('/not-authorized?reason=owner_exists')
  }
  return to(next)
}
