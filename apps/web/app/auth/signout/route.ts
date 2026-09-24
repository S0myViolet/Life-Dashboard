import { NextResponse } from 'next/server'
import { coreEnv } from '@/lib/env'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { E2E_COOKIE, e2eAuthEnabled } from '@/lib/server/e2e-auth'

export async function POST() {
  const origin = e2eAuthEnabled()
    ? (process.env.APP_URL ?? 'http://localhost:3000')
    : coreEnv().APP_URL
  // The /signed-out page clears the service worker caches and local drafts in the browser.
  const response = NextResponse.redirect(new URL('/signed-out', origin), { status: 303 })
  if (e2eAuthEnabled()) {
    response.cookies.delete(E2E_COOKIE)
    return response
  }
  const supabase = await createSupabaseServerClient()
  await supabase.auth.signOut()
  return response
}
