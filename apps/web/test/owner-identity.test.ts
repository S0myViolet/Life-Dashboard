import { describe, expect, it } from 'vitest'
import { evaluateOwnerIdentity, safeNextPath } from '@/lib/auth/owner-identity'

const google = (email: string, verified: unknown = true) => ({
  provider: 'google',
  identity_data: { email, email_verified: verified },
})

describe('evaluateOwnerIdentity', () => {
  it('allows the configured owner with a verified Google identity (case-insensitive)', () => {
    expect(
      evaluateOwnerIdentity(
        { id: 'u', email: 'Owner@Example.com', identities: [google('owner@example.com')] },
        'owner@example.com',
      ),
    ).toEqual({ allowed: true, email: 'owner@example.com' })
  })

  it('rejects another email even with a verified Google identity', () => {
    expect(
      evaluateOwnerIdentity(
        { id: 'u', email: 'else@example.com', identities: [google('else@example.com')] },
        'owner@example.com',
      ),
    ).toEqual({ allowed: false, reason: 'email_mismatch' })
  })

  it('rejects an unverified Google identity or a non-Google identity with the owner email', () => {
    expect(
      evaluateOwnerIdentity(
        { id: 'u', email: 'owner@example.com', identities: [google('owner@example.com', false)] },
        'owner@example.com',
      ),
    ).toEqual({ allowed: false, reason: 'no_verified_google_identity' })
    expect(
      evaluateOwnerIdentity(
        {
          id: 'u',
          email: 'owner@example.com',
          identities: [
            {
              provider: 'github',
              identity_data: { email: 'owner@example.com', email_verified: true },
            },
          ],
        },
        'owner@example.com',
      ),
    ).toEqual({ allowed: false, reason: 'no_verified_google_identity' })
  })

  it('rejects a primary email that matches while the Google identity belongs to someone else', () => {
    expect(
      evaluateOwnerIdentity(
        { id: 'u', email: 'owner@example.com', identities: [google('attacker@example.com')] },
        'owner@example.com',
      ),
    ).toEqual({ allowed: false, reason: 'no_verified_google_identity' })
  })

  it('rejects missing users and an empty configured owner', () => {
    expect(evaluateOwnerIdentity(null, 'owner@example.com')).toEqual({
      allowed: false,
      reason: 'no_user',
    })
    expect(evaluateOwnerIdentity({ id: 'u', email: '', identities: [] }, '')).toEqual({
      allowed: false,
      reason: 'email_mismatch',
    })
  })
})

describe('safeNextPath', () => {
  it('only allows same-origin relative paths', () => {
    expect(safeNextPath('/plan?view=week')).toBe('/plan?view=week')
    expect(safeNextPath('//evil.example')).toBe('/')
    expect(safeNextPath('/\\evil.example')).toBe('/')
    expect(safeNextPath('https://evil.example')).toBe('/')
    expect(safeNextPath(null)).toBe('/')
  })
})
