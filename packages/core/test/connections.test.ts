import { describe, expect, it } from 'vitest'
import {
  CONNECTION_PROVIDER_INFO,
  CONNECTION_STATUSES,
  GOOGLE_SCOPES,
  MICROSOFT_SCOPES,
  PROVIDERS,
  connectionProviders,
  connectionScopeCoverage,
  isOAuthConnectProvider,
  missingConnectionSettings,
  normalizeGrantedScopes,
  parseScopeString,
  STORED_CONNECTION_STATUSES,
} from '../src/index.ts'

describe('provider metadata', () => {
  it('covers every catalog provider exactly once, in catalog order', () => {
    expect(connectionProviders().map((p) => p.provider)).toEqual([...PROVIDERS])
    for (const p of PROVIDERS) {
      const info = CONNECTION_PROVIDER_INFO[p]
      expect(info.provider).toBe(p)
      expect(info.displayName.length).toBeGreaterThan(0)
      expect(info.provides.length).toBeGreaterThan(10)
      expect(info.syncMilestone).toBeGreaterThanOrEqual(info.connectMilestone)
      for (const name of info.requiredSettings) expect(name).toMatch(/^[A-Z][A-Z0-9_]+$/)
      if (info.authKind === 'oauth') expect(info.scopes.length).toBeGreaterThan(0)
      else expect(info.scopes).toEqual([])
    }
  })

  it('requests exactly the read-only scopes named in the research notes', () => {
    expect(CONNECTION_PROVIDER_INFO.google.scopes).toEqual([
      'openid',
      'email',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ])
    expect(CONNECTION_PROVIDER_INFO.microsoft.scopes).toEqual([
      'offline_access',
      'openid',
      'profile',
      'email',
      'User.Read',
      'Mail.Read',
      'Calendars.Read',
    ])
    // Nothing that could write, send or delete.
    const all = [...GOOGLE_SCOPES, ...MICROSOFT_SCOPES].join(' ')
    expect(all).not.toMatch(/send|modify|compose|ReadWrite|\.events(?!\.readonly)|calendar(?=\s|$)/)
  })

  it('only Google and Microsoft connect through the OAuth routes in this milestone, and allow several accounts', () => {
    expect(isOAuthConnectProvider('google')).toBe(true)
    expect(isOAuthConnectProvider('microsoft')).toBe(true)
    expect(isOAuthConnectProvider('whoop')).toBe(false)
    expect(isOAuthConnectProvider('../google')).toBe(false)
    expect(CONNECTION_PROVIDER_INFO.google.multiAccount).toBe(true)
    expect(CONNECTION_PROVIDER_INFO.microsoft.multiAccount).toBe(true)
  })

  it('reports missing setting names, treating blanks as missing', () => {
    const env: Record<string, string> = { GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: '  ' }
    expect(missingConnectionSettings('google', (n) => env[n])).toEqual(['GOOGLE_OAUTH_CLIENT_SECRET'])
    expect(missingConnectionSettings('rss', () => undefined)).toEqual([])
  })

  it('stored statuses are a subset of the catalog vocabulary', () => {
    for (const s of STORED_CONNECTION_STATUSES) expect(CONNECTION_STATUSES).toContain(s)
  })
})

describe('granted scopes', () => {
  it('normalises Google userinfo aliases and Microsoft Graph prefixes', () => {
    expect(
      normalizeGrantedScopes(
        'google',
        parseScopeString(
          'https://www.googleapis.com/auth/userinfo.email openid https://www.googleapis.com/auth/gmail.readonly openid',
        ),
      ),
    ).toEqual(['email', 'openid', 'https://www.googleapis.com/auth/gmail.readonly'])
    expect(
      normalizeGrantedScopes('microsoft', [
        'https://graph.microsoft.com/Mail.Read',
        'https://graph.microsoft.com/user.read',
        'openid',
      ]),
    ).toEqual(['Mail.Read', 'User.Read', 'openid'])
  })

  it('detects a partial Google grant (calendar granted, Gmail declined)', () => {
    const c = connectionScopeCoverage('google', [
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ])
    expect(c).toEqual({
      missing: ['https://www.googleapis.com/auth/gmail.readonly'],
      mail: false,
      calendar: true,
    })
  })

  it('needs both calendar scopes for calendar, and judges Microsoft by resource scopes only', () => {
    expect(
      connectionScopeCoverage('google', [
        ...GOOGLE_SCOPES.filter((s) => !s.endsWith('events.readonly')),
      ]).calendar,
    ).toBe(false)
    expect(
      connectionScopeCoverage('microsoft', ['openid', 'User.Read', 'Mail.Read', 'Calendars.Read']),
    ).toEqual({ missing: [], mail: true, calendar: true })
    expect(connectionScopeCoverage('microsoft', ['User.Read', 'Mail.Read'])).toEqual({
      missing: ['Calendars.Read'],
      mail: true,
      calendar: false,
    })
  })
})
