// Route handlers end to end against a real database. Provider responses are
// SYNTHETIC FIXTURES (not captured from the live service).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { SessionState } from '@/lib/server/session'
import {
  APP_URL,
  coreTestEnv,
  jsonResponse,
  providerFetch,
  setupConnectionsTest,
  type ConnectionsTestEnv,
} from './connections-helpers'

const session = vi.hoisted(() => ({ state: { status: 'signed_out' } as SessionState }))
vi.mock('@/lib/server/session', () => ({
  getSessionState: async () => session.state,
}))

let env: ConnectionsTestEnv
const savedEnv = { ...process.env }

beforeAll(async () => {
  env = await setupConnectionsTest()
  Object.assign(process.env, coreTestEnv(env.t.url, env.keyB64), env.settings)
})
afterAll(async () => {
  const { getDb } = await import('@/lib/server/db')
  await getDb().end({ timeout: 5 })
  process.env = savedEnv
  vi.unstubAllGlobals()
  await env?.t.drop()
})
beforeEach(async () => {
  session.state = { status: 'owner', session: { claims: env.owner, userId: env.owner.sub, email: env.owner.email ?? null } }
  await env.t.db`delete from public.connections`
  await env.t.db`delete from private.oauth_states`
  vi.unstubAllGlobals()
})

async function routes() {
  const start = await import('@/app/api/connections/[provider]/start/route')
  const callback = await import('@/app/api/connections/[provider]/callback/route')
  return { start: start.GET, callback: callback.GET }
}

const params = (provider: string) => ({ params: Promise.resolve({ provider }) })

function cookieFrom(res: Response, name: string): { value: string; attrs: string } | null {
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(';')
    const [k, v] = pair!.split('=')
    if (k === name) return { value: v ?? '', attrs: attrs.join(';').toLowerCase() }
  }
  return null
}

describe('GET /api/connections/[provider]/start', () => {
  it('requires the owner session', async () => {
    const { start } = await routes()
    session.state = { status: 'signed_out' }
    const out = await start(new NextRequest(`${APP_URL}/api/connections/google/start`), params('google'))
    expect(out.status).toBe(303)
    expect(out.headers.get('location')).toBe(`${APP_URL}/login?next=%2Fsettings%2Fconnections`)

    session.state = { status: 'not_owner', claims: { sub: '00000000-0000-4000-8000-000000000001' } }
    const stranger = await start(new NextRequest(`${APP_URL}/api/connections/google/start`), params('google'))
    expect(stranger.headers.get('location')).toBe(`${APP_URL}/not-authorized`)
    const [n] = await env.t.db<{ n: number }[]>`select count(*)::int as n from private.oauth_states`
    expect(n!.n).toBe(0)
  })

  it('404s for providers without an OAuth connect flow', async () => {
    const { start, callback } = await routes()
    for (const p of ['lunchflow', 'whoop', 'evil']) {
      expect((await start(new NextRequest(`${APP_URL}/api/connections/${p}/start`), params(p))).status).toBe(404)
      expect((await callback(new NextRequest(`${APP_URL}/api/connections/${p}/callback`), params(p))).status).toBe(404)
    }
  })

  it('sets a callback-scoped, httpOnly, Lax state cookie and redirects to the consent screen', async () => {
    const { start } = await routes()
    const res = await start(new NextRequest(`${APP_URL}/api/connections/google/start`), params('google'))
    expect(res.status).toBe(303)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const location = new URL(res.headers.get('location')!)
    expect(location.origin).toBe('https://accounts.google.com')
    expect(location.searchParams.get('redirect_uri')).toBe(`${APP_URL}/api/connections/google/callback`)
    const cookie = cookieFrom(res, 'ph_oauth_google')!
    expect(cookie.value).toBe(location.searchParams.get('state'))
    expect(cookie.attrs).toContain('httponly')
    expect(cookie.attrs).toContain('secure')
    expect(cookie.attrs).toContain('samesite=lax')
    expect(cookie.attrs).toContain('path=/api/connections/google/callback')
    expect(cookie.attrs).toContain('max-age=600')
  })

  it('sends the owner back with needs_setup when the provider is not configured', async () => {
    const { start } = await routes()
    const saved = process.env.MICROSOFT_CLIENT_SECRET
    delete process.env.MICROSOFT_CLIENT_SECRET
    try {
      const res = await start(new NextRequest(`${APP_URL}/api/connections/microsoft/start`), params('microsoft'))
      expect(res.headers.get('location')).toBe(
        `${APP_URL}/settings/connections?provider=microsoft&error=needs_setup`,
      )
      expect(cookieFrom(res, 'ph_oauth_microsoft')).toBeNull()
    } finally {
      process.env.MICROSOFT_CLIENT_SECRET = saved
    }
  })
})

describe('GET /api/connections/[provider]/callback', () => {
  it('completes the flow with the matching cookie, clears the cookie and redirects with a closed code', async () => {
    const { start, callback } = await routes()
    const begun = await start(new NextRequest(`${APP_URL}/api/connections/google/start`), params('google'))
    const state = cookieFrom(begun, 'ph_oauth_google')!.value
    const fake = providerFetch(() => new Date())
    vi.stubGlobal('fetch', fake.fetch)

    const res = await callback(
      new NextRequest(`${APP_URL}/api/connections/google/callback?state=${state}&code=synthetic-code&scope=x`, {
        headers: { cookie: `ph_oauth_google=${state}` },
      }),
      params('google'),
    )
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/connections?provider=google&result=connected`)
    const cleared = cookieFrom(res, 'ph_oauth_google')!
    expect(cleared.value).toBe('')
    expect(cleared.attrs).toContain('max-age=0')
    const [n] = await env.t.db<{ n: number }[]>`select count(*)::int as n from public.connections`
    expect(n!.n).toBe(1)
  })

  it('without the cookie nothing is exchanged or connected', async () => {
    const { start, callback } = await routes()
    const begun = await start(new NextRequest(`${APP_URL}/api/connections/google/start`), params('google'))
    const state = cookieFrom(begun, 'ph_oauth_google')!.value
    const fake = providerFetch(() => new Date())
    vi.stubGlobal('fetch', fake.fetch)
    const res = await callback(
      new NextRequest(`${APP_URL}/api/connections/google/callback?state=${state}&code=c`),
      params('google'),
    )
    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/connections?provider=google&error=state_mismatch`)
    expect(fake.calls).toHaveLength(0)
  })

  it('the callback also requires the owner session', async () => {
    const { callback } = await routes()
    session.state = { status: 'signed_out' }
    const res = await callback(
      new NextRequest(`${APP_URL}/api/connections/google/callback?state=${'a'.repeat(43)}&code=c`, {
        headers: { cookie: `ph_oauth_google=${'a'.repeat(43)}` },
      }),
      params('google'),
    )
    expect(res.headers.get('location')).toBe(`${APP_URL}/login?next=%2Fsettings%2Fconnections`)
  })

  it('provider error text never reaches the redirect', async () => {
    const { start, callback } = await routes()
    const begun = await start(new NextRequest(`${APP_URL}/api/connections/google/start`), params('google'))
    const state = cookieFrom(begun, 'ph_oauth_google')!.value
    vi.stubGlobal(
      'fetch',
      providerFetch(() => new Date(), {
        googleToken: () =>
          jsonResponse({ error: 'invalid_grant', error_description: 'Bad code owner.synthetic@gmail.com' }, 400),
      }).fetch,
    )
    const res = await callback(
      new NextRequest(
        `${APP_URL}/api/connections/google/callback?state=${state}&code=c&error_description=${encodeURIComponent('<script>')}`,
        { headers: { cookie: `ph_oauth_google=${state}` } },
      ),
      params('google'),
    )
    expect(res.headers.get('location')).toBe(`${APP_URL}/settings/connections?provider=google&error=exchange_failed`)
  })
})
