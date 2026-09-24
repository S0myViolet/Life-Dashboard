/**
 * Test-only sign-in for Playwright. Returns 404 unless e2eAuthEnabled().
 * Signs in as the owner recorded in the database (RLS still applies).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { safeNextPath } from '@/lib/auth/owner-identity'
import { serviceTransaction } from '@/lib/server/db'
import { E2E_COOKIE, e2eAuthEnabled, encodeE2eSession } from '@/lib/server/e2e-auth'

export async function GET(request: NextRequest) {
  if (!e2eAuthEnabled()) return new NextResponse('Not found', { status: 404 })
  const [owner] = await serviceTransaction(
    (tx) => tx<{ userId: string; email: string }[]>`select user_id, email from private.owner`,
  )
  if (!owner) return new NextResponse('No owner seeded', { status: 409 })
  const next = safeNextPath(request.nextUrl.searchParams.get('next'))
  const response = NextResponse.redirect(new URL(next, request.url))
  response.cookies.set(
    E2E_COOKIE,
    encodeE2eSession({ sub: owner.userId, email: owner.email }, process.env.PH_E2E_AUTH_SECRET!),
    {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    },
  )
  return response
}
