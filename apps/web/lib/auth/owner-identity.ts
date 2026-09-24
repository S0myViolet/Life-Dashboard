/**
 * Decide whether a Supabase Auth user may become/remain the dashboard owner.
 * Pure function so it can be tested without Supabase.
 *
 * Rule: the user must hold a Google identity whose verified email equals
 * OWNER_EMAIL, and the account's primary email must match too.
 */
export interface AuthIdentityLike {
  provider: string
  identity_data?: Record<string, unknown> | null
}

export interface AuthUserLike {
  id: string
  email?: string | null
  identities?: AuthIdentityLike[] | null
}

export type OwnerIdentityVerdict =
  | { allowed: true; email: string }
  | { allowed: false; reason: 'no_user' | 'email_mismatch' | 'no_verified_google_identity' }

const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

export function evaluateOwnerIdentity(
  user: AuthUserLike | null | undefined,
  ownerEmail: string,
): OwnerIdentityVerdict {
  if (!user) return { allowed: false, reason: 'no_user' }
  const owner = norm(ownerEmail)
  if (!owner || norm(user.email) !== owner) return { allowed: false, reason: 'email_mismatch' }
  const verifiedGoogle = (user.identities ?? []).some((identity) => {
    if (identity.provider !== 'google') return false
    const data = identity.identity_data ?? {}
    const verified = data.email_verified === true || data.email_verified === 'true'
    return verified && norm(data.email) === owner
  })
  if (!verifiedGoogle) return { allowed: false, reason: 'no_verified_google_identity' }
  return { allowed: true, email: owner }
}

/** Only allow same-origin relative paths after sign-in (no open redirects). */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
  return next
}
