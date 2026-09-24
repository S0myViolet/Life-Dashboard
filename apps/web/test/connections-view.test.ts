import { describe, expect, it } from 'vitest'
import { PROVIDERS, type Provider } from '@personal-home/core'
import type { ConnectionRow } from '@personal-home/db'
import { MICROSOFT_CONSENT_PAGES } from '@personal-home/integrations'
import { connectionsFlash } from '@/lib/integrations/flash'
import { formatAbsolute, formatRelative } from '@/lib/integrations/format'
import { OAUTH_RESULT_ERRORS } from '@/lib/integrations/oauth-flow-codes'
import { isSameOriginRequest } from '@/lib/integrations/request-guard'
import { buildConnectionsView, type ProviderView } from '@/lib/integrations/view'

const at = new Date('2026-09-24T10:00:00Z')

function row(overrides: Partial<ConnectionRow> & { provider: Provider }): ConnectionRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    accountLabel: 'owner@example.com',
    externalAccountId: 'ext-1',
    status: 'connected',
    grantedScopes: [],
    lastAttemptAt: at,
    lastSuccessAt: at,
    lastErrorCode: null,
    lastErrorMessage: null,
    nextAttemptAt: null,
    consecutiveFailures: 0,
    pausedAt: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  }
}

const GOOGLE_ALL = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
]

const configured = () => ({ configured: true, missing: [] })

function find(groups: ReturnType<typeof buildConnectionsView>, p: Provider): ProviderView {
  for (const g of groups) for (const v of g.providers) if (v.info.provider === p) return v
  throw new Error(`missing ${p}`)
}

describe('buildConnectionsView', () => {
  it('shows every catalog provider once, grouped, and is useful with nothing connected', () => {
    const groups = buildConnectionsView({ rows: [], setup: configured })
    const all = groups.flatMap((g) => g.providers.map((p) => p.info.provider))
    expect([...all].sort()).toEqual([...PROVIDERS].sort())
    expect(groups.map((g) => g.label)).toEqual([
      'Mail and calendar',
      'AI project conversations',
      'Money',
      'Health',
      'Interests',
    ])
    const google = find(groups, 'google')
    expect(google.availability).toEqual({ kind: 'connectable' })
    expect(google.connectHref).toBe('/api/connections/google/start')
    expect(google.accounts).toEqual([])
    expect(find(groups, 'chatgpt').availability).toEqual({ kind: 'extension' })
    expect(find(groups, 'claude').availability).toEqual({ kind: 'extension' })
    expect(find(groups, 'lunchflow').availability).toEqual({ kind: 'api_key_configured' })
    for (const p of ['whoop', 'spotify', 'football_data', 'rss'] as const)
      expect(find(groups, p).availability).toMatchObject({ kind: 'later', milestone: 3 })
  })

  it('names missing settings (never values) and offers no connect link when setup is missing', () => {
    const groups = buildConnectionsView({
      rows: [row({ provider: 'google', status: 'needs_reconnect' })],
      setup: (p) =>
        p === 'google' || p === 'whoop'
          ? {
              configured: false,
              missing: p === 'google' ? ['GOOGLE_OAUTH_CLIENT_SECRET'] : ['WHOOP_CLIENT_ID'],
            }
          : { configured: true, missing: [] },
    })
    const google = find(groups, 'google')
    expect(google.availability).toEqual({
      kind: 'needs_setup',
      missing: ['GOOGLE_OAUTH_CLIENT_SECRET'],
    })
    expect(google.connectHref).toBeNull()
    expect(google.setupHref).toBe('/settings/connections/setup#google')
    // Existing accounts stay visible, but reconnecting needs the settings first.
    expect(google.accounts[0]!.reconnectHref).toBeNull()
    expect(find(groups, 'whoop').availability).toEqual({
      kind: 'later',
      milestone: 3,
      missing: ['WHOOP_CLIENT_ID'],
    })
  })

  it('lists several accounts per provider with their health', () => {
    const next = new Date('2026-09-24T10:05:00Z')
    const groups = buildConnectionsView({
      rows: [
        row({
          provider: 'google',
          id: 'a',
          accountLabel: 'one@gmail.com',
          grantedScopes: GOOGLE_ALL,
        }),
        row({
          provider: 'google',
          id: 'b',
          accountLabel: 'two@example.org',
          status: 'error',
          grantedScopes: GOOGLE_ALL,
          lastErrorCode: 'rate_limited.http_429',
          lastErrorMessage: 'Google Gmail profile failed: HTTP 429',
          nextAttemptAt: next,
        }),
        row({
          provider: 'google',
          id: 'c',
          accountLabel: 'three@gmail.com',
          status: 'needs_reconnect',
          grantedScopes: GOOGLE_ALL,
          lastErrorCode: 'auth.invalid_grant',
          lastErrorMessage: 'Google no longer accepts the stored authorization (invalid_grant).',
        }),
        row({
          provider: 'microsoft',
          id: 'd',
          status: 'paused',
          pausedAt: at,
          grantedScopes: ['User.Read', 'Mail.Read', 'Calendars.Read'],
        }),
      ],
      setup: configured,
    })
    const google = find(groups, 'google')
    expect(google.accounts.map((a) => [a.label, a.status])).toEqual([
      ['one@gmail.com', 'connected'],
      ['two@example.org', 'error'],
      ['three@gmail.com', 'needs_reconnect'],
    ])
    const [one, two, three] = google.accounts
    expect(one!.offerReconnect).toBe(false)
    expect(one!.errorMessage).toBeNull()
    expect(two!.nextAttemptAt).toEqual(next)
    expect(two!.errorMessage).toContain('HTTP 429')
    expect(three!.reconnectHref).toBe('/api/connections/google/start?account=c')
    expect(google.connectHref).toBe('/api/connections/google/start')
    const ms = find(groups, 'microsoft').accounts[0]!
    expect(ms.paused).toBe(true)
    expect(ms.nextAttemptAt).toBeNull()
    expect(find(groups, 'microsoft').supportsRevoke).toBe(false)
    expect(google.supportsRevoke).toBe(true)
  })

  it('offers Check now only for a configuration error on a configured provider', () => {
    const rows = [
      row({
        provider: 'google',
        id: 'cfg',
        status: 'error',
        grantedScopes: GOOGLE_ALL,
        lastErrorCode: 'config.api_disabled',
        lastErrorMessage: 'The API is not enabled in the Google Cloud project.',
        nextAttemptAt: new Date('2026-09-24T16:00:00Z'),
      }),
      row({
        provider: 'google',
        id: 'rl',
        status: 'error',
        grantedScopes: GOOGLE_ALL,
        lastErrorCode: 'rate_limited.http_429',
        nextAttemptAt: new Date('2026-09-24T11:00:00Z'),
      }),
      row({ provider: 'google', id: 'ok', grantedScopes: GOOGLE_ALL }),
    ]
    const accounts = find(buildConnectionsView({ rows, setup: configured }), 'google').accounts
    expect(accounts.map((a) => [a.id, a.offerCheckNow])).toEqual([
      ['cfg', true],
      ['rl', false],
      ['ok', false],
    ])
    const unset = buildConnectionsView({
      rows,
      setup: () => ({ configured: false, missing: ['GOOGLE_OAUTH_CLIENT_ID'] }),
    })
    expect(find(unset, 'google').accounts.some((a) => a.offerCheckNow)).toBe(false)
  })

  it('flags partially granted access and offers a reconnect', () => {
    const groups = buildConnectionsView({
      rows: [
        row({
          provider: 'google',
          grantedScopes: [
            'openid',
            'email',
            'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
            'https://www.googleapis.com/auth/calendar.events.readonly',
          ],
        }),
        row({ provider: 'microsoft', id: 'm', grantedScopes: ['User.Read'] }),
      ],
      setup: configured,
    })
    const g = find(groups, 'google').accounts[0]!
    expect(g.missingAccess).toEqual(['Gmail (read-only)'])
    expect(g.noDataAccess).toBe(false)
    expect(g.offerReconnect).toBe(true)
    const m = find(groups, 'microsoft').accounts[0]!
    expect(m.missingAccess).toEqual(['Mail (read-only)', 'Calendars (read-only)'])
    expect(m.noDataAccess).toBe(true)
  })
})

describe('connectionsFlash', () => {
  it('maps every closed error code to a message, and ignores anything else', () => {
    for (const code of OAUTH_RESULT_ERRORS) {
      const f = connectionsFlash({ provider: 'google', error: code })
      expect(f?.message.length).toBeGreaterThan(10)
    }
    expect(connectionsFlash({ provider: 'google', error: '<script>alert(1)</script>' })).toBeNull()
    expect(connectionsFlash({ provider: 'evil', result: 'connected' })).toBeNull()
    expect(connectionsFlash({})).toBeNull()
  })

  it('reports connect and disconnect results honestly', () => {
    expect(connectionsFlash({ provider: 'google', result: 'connected' })).toEqual({
      tone: 'positive',
      message: 'Google account connected.',
    })
    expect(
      connectionsFlash({ provider: 'microsoft', result: 'reconnected', check: 'failed' })?.tone,
    ).toBe('caution')
    const ms = connectionsFlash({ disconnected: 'microsoft', revoke: 'not_supported' })!
    expect(ms.tone).toBe('caution')
    // The account kind is not known here: offer the personal and the work/school page.
    expect(ms.links?.map((l) => l.href)).toEqual([
      MICROSOFT_CONSENT_PAGES.personal,
      MICROSOFT_CONSENT_PAGES.workOrSchool,
    ])
    expect(ms.links?.map((l) => l.label).join(' ')).toMatch(/personal.*work or school/i)
    expect(
      connectionsFlash({ disconnected: 'google', revoke: 'failed' })?.links?.map((l) => l.href),
    ).toEqual(['https://myaccount.google.com/permissions'])
    expect(connectionsFlash({ disconnected: 'google', revoke: 'revoked' })?.tone).toBe('positive')
    expect(connectionsFlash({ disconnected: 'google', revoke: 'failed' })?.message).toContain(
      'revoking access at Google failed',
    )
    expect(connectionsFlash({ disconnected: 'google', revoke: 'bogus' })).toBeNull()
  })
})

describe('isSameOriginRequest', () => {
  it('accepts only the exact app origin', () => {
    const app = 'https://home.example.test'
    expect(isSameOriginRequest('https://home.example.test', app)).toBe(true)
    for (const bad of [
      null,
      undefined,
      '',
      'null',
      'http://home.example.test',
      'https://home.example.test.evil.example',
      'https://evil.example',
      'https://home.example.test:8443',
      'https://home.example.test/path',
      'not a url',
    ])
      expect(isSameOriginRequest(bad, app)).toBe(false)
  })
})

describe('format', () => {
  it('relative and absolute times', () => {
    expect(formatRelative(new Date(at.getTime() - 30_000), at)).toBe('just now')
    expect(formatRelative(new Date(at.getTime() - 5 * 60_000), at)).toBe('5 minutes ago')
    expect(formatRelative(new Date(at.getTime() + 60 * 60_000), at)).toBe('in 1 hour')
    expect(formatRelative(new Date(at.getTime() - 3 * 86_400_000), at)).toBe('3 days ago')
    expect(formatAbsolute(at, 'Europe/London')).toContain('11:00')
    expect(formatAbsolute(at, 'Not/AZone')).toBe(at.toISOString())
  })
})
