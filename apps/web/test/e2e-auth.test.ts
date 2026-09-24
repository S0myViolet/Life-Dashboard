/**
 * The Playwright-only sign-in (lib/server/e2e-auth.ts): when it is allowed to run,
 * and that its HMAC-signed cookie cannot be forged or tampered with.
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeE2eSession, e2eAuthEnabled, encodeE2eSession } from '@/lib/server/e2e-auth'

const SECRET = 'a'.repeat(32) + 'b'.repeat(32)
const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv
const OWNER = { sub: '6a1f2f7c-7a2e-4c1b-9d1e-1d7a2b3c4d5e', email: 'owner@example.com' }

describe('e2eAuthEnabled', () => {
  it('needs PH_E2E_AUTH=1 and a secret of at least 32 characters', () => {
    expect(e2eAuthEnabled(env({ PH_E2E_AUTH: '1', PH_E2E_AUTH_SECRET: SECRET }))).toBe(true)
    expect(e2eAuthEnabled(env({ PH_E2E_AUTH: '1', PH_E2E_AUTH_SECRET: 'x'.repeat(31) }))).toBe(
      false,
    )
    expect(e2eAuthEnabled(env({ PH_E2E_AUTH: '1' }))).toBe(false)
    expect(e2eAuthEnabled(env({ PH_E2E_AUTH: 'true', PH_E2E_AUTH_SECRET: SECRET }))).toBe(false)
    expect(e2eAuthEnabled(env({ PH_E2E_AUTH_SECRET: SECRET }))).toBe(false)
    expect(e2eAuthEnabled(env({}))).toBe(false)
  })

  it('is always off on Vercel', () => {
    const base = { PH_E2E_AUTH: '1', PH_E2E_AUTH_SECRET: SECRET }
    expect(e2eAuthEnabled(env({ ...base, VERCEL: '1' }))).toBe(false)
    expect(e2eAuthEnabled(env({ ...base, VERCEL_ENV: 'production' }))).toBe(false)
    expect(e2eAuthEnabled(env({ ...base, VERCEL_ENV: 'preview' }))).toBe(false)
  })
})

describe('e2e session cookie', () => {
  it('round-trips the signed claims', () => {
    expect(decodeE2eSession(encodeE2eSession(OWNER, SECRET), SECRET)).toEqual(OWNER)
    const noEmail = { sub: OWNER.sub, email: null }
    expect(decodeE2eSession(encodeE2eSession(noEmail, SECRET), SECRET)).toEqual(noEmail)
  })

  it('rejects a cookie signed with another secret', () => {
    const forged = encodeE2eSession(OWNER, 'c'.repeat(64))
    expect(decodeE2eSession(forged, SECRET)).toBeNull()
  })

  it('rejects a genuine signature moved onto a different payload', () => {
    const genuine = encodeE2eSession({ sub: 'someone-else', email: null }, SECRET)
    const [, mac] = genuine.split('.')
    const payload = Buffer.from(JSON.stringify(OWNER)).toString('base64url')
    expect(decodeE2eSession(`${payload}.${mac}`, SECRET)).toBeNull()
  })

  it('rejects truncated signatures, garbage and missing subjects', () => {
    const genuine = encodeE2eSession(OWNER, SECRET)
    for (const value of [
      undefined,
      '',
      '.',
      'not-a-session',
      genuine.slice(0, -1),
      `${genuine}x`,
      genuine.split('.')[0],
    ]) {
      expect(decodeE2eSession(value, SECRET), String(value)).toBeNull()
    }
    // Correctly signed, but the payload has no string subject.
    for (const claims of [{ email: OWNER.email }, { sub: 42 }, 'owner']) {
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
      const mac = createHmac('sha256', SECRET).update(payload).digest('base64url')
      expect(decodeE2eSession(`${payload}.${mac}`, SECRET)).toBeNull()
    }
  })
})
