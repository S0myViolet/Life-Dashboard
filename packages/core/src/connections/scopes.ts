/**
 * Granted-scope bookkeeping. Google (granular consent) and Microsoft (user or
 * admin policy) can grant fewer scopes than requested; the connection records
 * exactly what was granted and the UI turns off what is missing.
 */
import type { Provider } from '../catalog.ts'
import {
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_GMAIL_SCOPE,
  GOOGLE_SCOPES,
  MICROSOFT_SCOPES,
} from './providers.ts'

const GOOGLE_ALIASES: Record<string, string> = {
  'https://www.googleapis.com/auth/userinfo.email': 'email',
  'https://www.googleapis.com/auth/userinfo.profile': 'profile',
}

const GRAPH_PREFIX = 'https://graph.microsoft.com/'

/**
 * Canonical form of a granted scope list: Google's userinfo URLs become
 * `email`/`profile`; Microsoft Graph scopes lose the resource prefix and take
 * the requested casing. Deduplicated, order-stable.
 */
export function normalizeGrantedScopes(provider: Provider, scopes: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of scopes) {
    const s = raw.trim()
    if (!s) continue
    let v = s
    if (provider === 'google') {
      v = GOOGLE_ALIASES[s] ?? s
    } else if (provider === 'microsoft') {
      const bare = s.toLowerCase().startsWith(GRAPH_PREFIX) ? s.slice(GRAPH_PREFIX.length) : s
      v = MICROSOFT_SCOPES.find((m) => m.toLowerCase() === bare.toLowerCase()) ?? bare
    }
    if (!out.includes(v)) out.push(v)
  }
  return out
}

/** Split an OAuth `scope` response field (space-delimited). */
export function connectionParseScopeString(scope: string | null | undefined): string[] {
  return (scope ?? '').split(/\s+/).filter(Boolean)
}

export interface ScopeCoverage {
  /** Requested scopes that were not granted. */
  missing: string[]
  /** Features the granted scopes allow. */
  mail: boolean
  calendar: boolean
}

/**
 * What a connection can actually do with the scopes it holds.
 * Microsoft's token response does not always echo `offline_access`/`openid`;
 * those are judged by the presence of a refresh token / id, so only resource
 * scopes count as missing for it.
 */
export function connectionScopeCoverage(
  provider: Provider,
  granted: readonly string[],
): ScopeCoverage {
  const g = normalizeGrantedScopes(provider, granted)
  if (provider === 'google') {
    return {
      missing: GOOGLE_SCOPES.filter((s) => !g.includes(s)),
      mail: g.includes(GOOGLE_GMAIL_SCOPE),
      calendar: GOOGLE_CALENDAR_SCOPES.every((s) => g.includes(s)),
    }
  }
  if (provider === 'microsoft') {
    const resource = ['User.Read', 'Mail.Read', 'Calendars.Read']
    return {
      missing: resource.filter((s) => !g.includes(s)),
      mail: g.includes('Mail.Read'),
      calendar: g.includes('Calendars.Read'),
    }
  }
  return { missing: [], mail: false, calendar: false }
}

/** Short human names for scopes in the UI ("Gmail", "Calendar list", ...). */
export function connectionDescribeScope(scope: string): string {
  const names: Record<string, string> = {
    openid: 'Sign-in identity',
    email: 'Email address',
    profile: 'Basic profile',
    offline_access: 'Background access',
    [GOOGLE_GMAIL_SCOPE]: 'Gmail (read-only)',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly': 'Calendar list (read-only)',
    'https://www.googleapis.com/auth/calendar.events.readonly': 'Calendar events (read-only)',
    'User.Read': 'Profile',
    'Mail.Read': 'Mail (read-only)',
    'Calendars.Read': 'Calendars (read-only)',
  }
  return names[scope] ?? scope
}
