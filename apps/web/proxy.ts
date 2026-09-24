/**
 * Runs before matched requests: refreshes the Supabase session cookie and sends
 * signed-out visitors to /login. This is an optimistic check only; pages,
 * server actions and route handlers still call requireOwner()/getOwner(), and
 * RLS enforces ownership in the database.
 */
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const PUBLIC_PATHS = ['/login', '/auth/', '/not-authorized', '/signed-out', '/offline']

function isPublic(pathname: string) {
  return PUBLIC_PATHS.some((p) => (p.endsWith('/') ? pathname.startsWith(p) : pathname === p))
}

function e2eMode() {
  return (
    process.env.PH_E2E_AUTH === '1' &&
    (process.env.PH_E2E_AUTH_SECRET?.length ?? 0) >= 32 &&
    !process.env.VERCEL &&
    !process.env.VERCEL_ENV
  )
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

  if (e2eMode()) {
    const signedIn = Boolean(request.cookies.get('ph_e2e_session')?.value)
    if (
      !signedIn &&
      !isPublic(request.nextUrl.pathname) &&
      !request.nextUrl.pathname.startsWith('/api/')
    ) {
      return NextResponse.redirect(
        new URL(`/login?next=${encodeURIComponent(request.nextUrl.pathname)}`, request.url),
      )
    }
    return response
  }
  if (!url || !key) return response // Pages will show the configuration error.

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet)
          response.cookies.set(name, value, options)
        // Responses that set auth cookies must never be cached by a CDN.
        for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value)
      },
    },
  })

  const { data } = await supabase.auth.getClaims()
  const pathname = request.nextUrl.pathname

  if (!data?.claims && !isPublic(pathname) && !pathname.startsWith('/api/')) {
    const login = new URL('/login', request.url)
    login.searchParams.set('next', pathname)
    return NextResponse.redirect(login)
  }

  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

export const config = {
  matcher: [
    // Skip static assets, the service worker, the manifest, and machine endpoints
    // that authenticate with their own tokens (extension capture, internal jobs).
    '/((?!_next/static|_next/image|favicon.ico|icons/|sw.js|manifest.webmanifest|api/capture/|api/internal/).*)',
  ],
}
