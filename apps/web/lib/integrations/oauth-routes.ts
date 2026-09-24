/**
 * Route handler bodies for GET /api/connections/<provider>/start and
 * GET /api/connections/<provider>/callback. Both require the dashboard owner's
 * session: connecting a mailbox is something the signed-in owner does, and it
 * never touches Supabase Auth or private.owner.
 *
 * The one-time state travels in the provider redirect and in an httpOnly,
 * SameSite=Lax cookie scoped to the callback path; the callback insists they
 * match, so a callback URL replayed in another browser (or a login-CSRF link)
 * connects nothing. Responses are redirects to same-origin paths carrying
 * closed result codes only.
 */
import 'server-only'
import { NextResponse, type NextRequest } from 'next/server'
import { isOAuthConnectProvider, type OAuthConnectProvider } from '@personal-home/core'
import { coreEnv } from '@/lib/env'
import { getDb } from '@/lib/server/db'
import { getSessionState } from '@/lib/server/session'
import {
  DEFAULT_CONNECTIONS_PATH,
  connectionOAuthBegin,
  connectionOAuthComplete,
  oauthResultLocation,
} from './oauth-flow'
import { oauthRedirectUri, oauthStateCookieName, serverSetting, tokenEncryptionKey } from './settings'

/** The consent screen plus the owner's decision must fit inside the 10-minute state lifetime. */
const STATE_COOKIE_MAX_AGE_S = 10 * 60

function redirectTo(path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, coreEnv().APP_URL), 303)
  res.headers.set('Cache-Control', 'no-store')
  return res
}

function cookiePath(provider: OAuthConnectProvider): string {
  return `/api/connections/${provider}/callback`
}

function secureCookies(): boolean {
  return new URL(coreEnv().APP_URL).protocol === 'https:'
}

/** Owner check for route handlers: redirect instead of rendering anything. */
async function ownerGate(returnPath: string): Promise<NextResponse | null> {
  const state = await getSessionState()
  if (state.status === 'owner') return null
  if (state.status === 'not_owner') return redirectTo('/not-authorized')
  return redirectTo(`/login?next=${encodeURIComponent(returnPath)}`)
}

export async function connectStart(request: NextRequest, providerParam: string): Promise<Response> {
  if (!isOAuthConnectProvider(providerParam)) return new NextResponse('Not found', { status: 404 })
  const provider = providerParam
  const denied = await ownerGate(DEFAULT_CONNECTIONS_PATH)
  if (denied) return denied

  const begun = await connectionOAuthBegin({
    db: getDb(),
    provider,
    redirectUri: oauthRedirectUri(provider),
    key: await tokenEncryptionKey(),
    setting: serverSetting,
    returnTo: DEFAULT_CONNECTIONS_PATH,
    reconnectConnectionId: request.nextUrl.searchParams.get('account'),
  })
  if (!begun.ok) return redirectTo(oauthResultLocation(provider, { ok: false, error: begun.error }))

  const res = NextResponse.redirect(begun.authorizationUrl, 303)
  res.headers.set('Cache-Control', 'no-store')
  res.cookies.set(oauthStateCookieName(provider), begun.state, {
    httpOnly: true,
    secure: secureCookies(),
    // Lax: sent on the provider's top-level GET redirect back to us, never on cross-site subrequests.
    sameSite: 'lax',
    path: cookiePath(provider),
    maxAge: STATE_COOKIE_MAX_AGE_S,
  })
  return res
}

export async function connectCallback(request: NextRequest, providerParam: string): Promise<Response> {
  if (!isOAuthConnectProvider(providerParam)) return new NextResponse('Not found', { status: 404 })
  const provider = providerParam
  const denied = await ownerGate(DEFAULT_CONNECTIONS_PATH)
  if (denied) return denied

  let location: string
  try {
    const result = await connectionOAuthComplete({
      db: getDb(),
      provider,
      redirectUri: oauthRedirectUri(provider),
      key: await tokenEncryptionKey(),
      setting: serverSetting,
      query: request.nextUrl.searchParams,
      cookieState: request.cookies.get(oauthStateCookieName(provider))?.value,
      fetch: globalThis.fetch,
      now: () => new Date(),
      signal: request.signal,
    })
    location = oauthResultLocation(provider, result)
  } catch {
    // Database or configuration trouble. Log nothing from the request: it carries the code.
    location = oauthResultLocation(provider, { ok: false, error: 'internal_error' })
  }

  const res = redirectTo(location)
  // The state is single use whatever happened.
  res.cookies.set(oauthStateCookieName(provider), '', {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'lax',
    path: cookiePath(provider),
    maxAge: 0,
  })
  return res
}
