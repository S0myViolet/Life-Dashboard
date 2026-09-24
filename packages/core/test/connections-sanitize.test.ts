import { describe, expect, it } from 'vitest'
import {
  ConnectionError,
  connectionFailure,
  isConnectionError,
  sanitizeConnectionErrorMessage as clean,
  toConnectionFailure,
} from '../src/index.ts'

describe('sanitizeConnectionErrorMessage', () => {
  it('strips bearer credentials and token-bearing key/value pairs', () => {
    const out = clean(
      'Authorization: Bearer ya29.a0AfH6SMBxyz123 refresh_token=1//0gAbCdEf-123 "access_token":"EwB4A8l6BAAU" code=4/0AX4XfWh',
    )
    expect(out).not.toMatch(/ya29|1\/\/0g|EwB4A8|4\/0AX4/)
    expect(out).toContain('Bearer [redacted]')
    expect(out).toContain('refresh_token=[redacted]')
  })

  it('strips JWTs, Google and Microsoft token shapes and long opaque strings', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl'
    const out = clean(
      `id ${jwt} rt 1//03abcDEF_ghi-jkl code 4/0AVHEtk7abcdefg msa M.C507_BAY.2.U.abc key sk_${"live"}_51Habcdefghijklmnopqrstuvwxyz0123`,
    )
    expect(out).not.toContain('eyJ')
    expect(out).not.toContain('1//03')
    expect(out).not.toContain('4/0AVH')
    expect(out).not.toContain('M.C507')
    expect(out).not.toContain('sk_live')
  })

  it('removes emails and URL query strings but keeps the endpoint path', () => {
    const out = clean(
      'GET https://gmail.googleapis.com/gmail/v1/users/me/profile?access_token=abc&x=1#frag failed for Owner.Name+tag@Example.co.uk',
    )
    expect(out).toBe(
      'GET https://gmail.googleapis.com/gmail/v1/users/me/profile?[redacted] failed for [email]',
    )
    expect(clean('see https://login.microsoftonline.com/common/oauth2/v2.0/token')).toBe(
      'see https://login.microsoftonline.com/common/oauth2/v2.0/token',
    )
  })

  it('keeps ordinary diagnostic words and error codes', () => {
    expect(clean('Google refused the refresh token (invalid_grant), HTTP 400')).toBe(
      'Google refused the refresh token (invalid_grant), HTTP 400',
    )
    expect(clean('error_code: AADSTS70008')).toBe('error_code: AADSTS70008')
  })

  it('drops control characters, collapses whitespace and caps the length', () => {
    expect(clean('line1\n\r\tline2\u0000   end')).toBe('line1 line2 end')
    const long = clean('word '.repeat(200), 50)
    expect(long.length).toBeLessThanOrEqual(50)
    expect(long.endsWith('…')).toBe(true)
    expect(clean(undefined)).toBe('')
    expect(clean(new Error('state=abc123 failed'))).toBe('state=[redacted] failed')
  })
})

describe('ConnectionError', () => {
  it('carries a classified failure and is recognised structurally', () => {
    const err = new ConnectionError(connectionFailure('auth', 'invalid_grant', 'Refresh token rejected'))
    expect(isConnectionError(err)).toBe(true)
    expect(toConnectionFailure(err).code).toBe('auth.invalid_grant')
    expect(isConnectionError(new Error('x'))).toBe(false)
  })

  it('treats unknown errors as transient with a sanitised message', () => {
    const f = toConnectionFailure(new Error('socket hang up for owner@example.com'))
    expect(f).toMatchObject({ kind: 'transient', code: 'transient.unexpected' })
    expect(f.message).toBe('Unexpected error: socket hang up for [email]')
  })
})
