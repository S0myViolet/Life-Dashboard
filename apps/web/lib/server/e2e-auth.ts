/**
 * Test-only sign-in used by Playwright, because Google sign-in cannot run in CI.
 *
 * Enabled only when ALL of these hold:
 *   PH_E2E_AUTH=1, PH_E2E_AUTH_SECRET is at least 32 characters, and the app is
 *   not running on Vercel (VERCEL / VERCEL_ENV unset).
 * The cookie is an HMAC-signed { sub, email }. Row Level Security still applies:
 * the signed subject must be the owner recorded in the database.
 */
import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { OwnerClaims } from '@personal-home/db'

export const E2E_COOKIE = 'ph_e2e_session'

export function e2eAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.PH_E2E_AUTH === '1' &&
    (env.PH_E2E_AUTH_SECRET?.length ?? 0) >= 32 &&
    !env.VERCEL &&
    !env.VERCEL_ENV
  )
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function encodeE2eSession(claims: OwnerClaims, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: claims.sub, email: claims.email ?? null }),
  ).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

export function decodeE2eSession(value: string | undefined, secret: string): OwnerClaims | null {
  if (!value) return null
  const [payload, mac] = value.split('.')
  if (!payload || !mac) return null
  const expected = Buffer.from(sign(payload, secret))
  const given = Buffer.from(mac)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown
      email?: unknown
    }
    if (typeof parsed.sub !== 'string') return null
    return { sub: parsed.sub, email: typeof parsed.email === 'string' ? parsed.email : null }
  } catch {
    return null
  }
}
