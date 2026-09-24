import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import type { BrowserContext, Page } from '@playwright/test'

export const E2E_COOKIE = 'ph_e2e_session'

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set; run through playwright.config.ts (global setup)`)
  return value
}

export const owner = {
  get id() {
    return env('PH_E2E_OWNER_ID')
  },
  get email() {
    return env('PH_E2E_OWNER_EMAIL')
  },
}

export const stranger = {
  get id() {
    return env('PH_E2E_STRANGER_ID')
  },
  get email() {
    return env('PH_E2E_STRANGER_EMAIL')
  },
}

/**
 * Same format as lib/server/e2e-auth.ts encodeE2eSession (which cannot be imported
 * here because it is server-only): base64url(JSON {sub, email}) + '.' + HMAC-SHA256.
 */
export function e2eSessionCookie(
  claims: { sub: string; email: string | null },
  secret: string = env('PH_E2E_AUTH_SECRET'),
): string {
  const payload = Buffer.from(JSON.stringify({ sub: claims.sub, email: claims.email })).toString(
    'base64url',
  )
  const mac = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${mac}`
}

export async function setSessionCookie(context: BrowserContext, baseURL: string, value: string) {
  await context.addCookies([
    { name: E2E_COOKIE, value, url: baseURL, httpOnly: true, sameSite: 'Lax' },
  ])
}

/** Sign in through the app's test-only route (the same cookie a real test login sets). */
export async function signInAsOwner(page: Page, next = '/') {
  await page.goto(`/api/test/login?next=${encodeURIComponent(next)}`)
}

/** Run SQL against the e2e database as the superuser. Returns psql's unaligned output. */
export function sql(query: string): string {
  const res = spawnSync(
    'psql',
    [
      '-X',
      '-q',
      '-t',
      '-A',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      '127.0.0.1',
      '-p',
      process.env.PH_PG_PORT ?? '54329',
      '-U',
      'postgres',
      '-d',
      env('PH_E2E_DATABASE'),
      '-c',
      query,
    ],
    { encoding: 'utf8' },
  )
  if (res.status !== 0) throw new Error(`psql failed: ${res.stderr}`)
  return res.stdout.trim()
}

/** Put the owner's settings back to first-run defaults. */
export function resetOwnerSettings() {
  sql(
    `update public.owner_settings
     set timezone = 'Europe/London', timezone_confirmed = false, available_hours = null,
         home_layout = '[]'::jsonb, display_name = null`,
  )
}

export function localDateLabel(timeZone: string, at = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(at)
}

/** Read width/height from a PNG's IHDR chunk. */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  const signature = '89504e470d0a1a0a'
  if (bytes.subarray(0, 8).toString('hex') !== signature) throw new Error('not a PNG')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}
