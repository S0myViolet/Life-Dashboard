import { NextResponse, type NextRequest } from 'next/server'
import { coreEnv } from '@/lib/env'
import { safeNextPath } from '@/lib/auth/owner-identity'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const env = coreEnv()
  const next = safeNextPath(request.nextUrl.searchParams.get('next'))
  const supabase = await createSupabaseServerClient()
  const redirectTo = `${env.APP_URL}/auth/callback?next=${encodeURIComponent(next)}`
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, queryParams: { prompt: 'select_account' } },
  })
  if (error || !data.url) {
    return NextResponse.redirect(new URL('/login?error=start_failed', env.APP_URL))
  }
  return NextResponse.redirect(data.url)
}
