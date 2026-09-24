/**
 * Connection provider metadata for every provider in the catalog.
 *
 * Pure data: the web app renders the Connections screen from it, the job
 * handlers read setting names from it, and the adapters in
 * @personal-home/integrations use the scope lists. Setting NAMES live here;
 * values only ever come from the server environment.
 */
import { PROVIDERS, type Provider } from '../catalog.ts'

/** How an account is authorised. */
export const CONNECTION_AUTH_KINDS = ['oauth', 'api_key', 'extension', 'none'] as const
export type ConnectionAuthKind = (typeof CONNECTION_AUTH_KINDS)[number]

/** Where a provider sits on the Connections screen. */
export const CONNECTION_GROUPS = ['mail_calendar', 'projects', 'money', 'health', 'interests'] as const
export type ConnectionGroup = (typeof CONNECTION_GROUPS)[number]

export const CONNECTION_GROUP_LABELS: Record<ConnectionGroup, string> = {
  mail_calendar: 'Mail and calendar',
  projects: 'AI project conversations',
  money: 'Money',
  health: 'Health',
  interests: 'Interests',
}

/** The milestone this build delivers. Providers whose `connectMilestone` is later show "Arrives in Milestone N". */
export const CONNECTIONS_CURRENT_MILESTONE = 0

export interface ConnectionProviderInfo {
  provider: Provider
  displayName: string
  /** One sentence: what this connection provides. */
  provides: string
  group: ConnectionGroup
  authKind: ConnectionAuthKind
  /** Several accounts of this provider can be connected side by side. */
  multiAccount: boolean
  /** Milestone in which the owner can first connect/configure it. */
  connectMilestone: number
  /** Milestone in which its data is imported. */
  syncMilestone: number
  /**
   * Server settings (environment variable NAMES) the integration needs, beyond
   * the core settings every connection shares (TOKEN_ENCRYPTION_KEY, APP_URL).
   */
  requiredSettings: readonly string[]
  /** OAuth scopes requested, exactly as sent. Empty for non-OAuth providers. */
  scopes: readonly string[]
  /** False when the scope list has not yet been checked against the provider's current docs. */
  scopesVerified: boolean
}

/** Google: identity, Gmail read-only, calendar list read-only and events read-only (docs/research/oauth.md). */
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
] as const

export const GOOGLE_GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
] as const

/** Microsoft identity platform v2.0 (/common) delegated scopes (docs/research/oauth.md). */
export const MICROSOFT_SCOPES = [
  'offline_access',
  'openid',
  'profile',
  'email',
  'User.Read',
  'Mail.Read',
  'Calendars.Read',
] as const

export const CONNECTION_PROVIDER_INFO: Record<Provider, ConnectionProviderInfo> = {
  google: {
    provider: 'google',
    displayName: 'Google',
    provides: 'Gmail messages and Google Calendar events, read-only. Connect each Google account separately.',
    group: 'mail_calendar',
    authKind: 'oauth',
    multiAccount: true,
    connectMilestone: 0,
    syncMilestone: 2,
    requiredSettings: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'],
    scopes: GOOGLE_SCOPES,
    scopesVerified: true,
  },
  microsoft: {
    provider: 'microsoft',
    displayName: 'Microsoft (Outlook)',
    provides:
      'Outlook mail and calendar for personal and work accounts, read-only. Connect each account separately.',
    group: 'mail_calendar',
    authKind: 'oauth',
    multiAccount: true,
    connectMilestone: 0,
    syncMilestone: 2,
    requiredSettings: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
    scopes: MICROSOFT_SCOPES,
    scopesVerified: true,
  },
  chatgpt: {
    provider: 'chatgpt',
    displayName: 'ChatGPT',
    provides: 'Messages from conversations you select, collected by the Chrome helper.',
    group: 'projects',
    authKind: 'extension',
    multiAccount: false,
    connectMilestone: 0,
    syncMilestone: 2,
    requiredSettings: [],
    scopes: [],
    scopesVerified: true,
  },
  claude: {
    provider: 'claude',
    displayName: 'Claude',
    provides: 'Messages from conversations you select, collected by the Chrome helper.',
    group: 'projects',
    authKind: 'extension',
    multiAccount: false,
    connectMilestone: 0,
    syncMilestone: 2,
    requiredSettings: [],
    scopes: [],
    scopesVerified: true,
  },
  lunchflow: {
    provider: 'lunchflow',
    displayName: 'Lunch Flow (Revolut UK, HSBC UK)',
    provides:
      'Bank accounts, balances and transactions through the Lunch Flow Personal API, read-only. UK data refreshes about daily.',
    group: 'money',
    authKind: 'api_key',
    multiAccount: false,
    // Milestone 0 validates the owner's two account types with scripts/verify-lunchflow.mjs.
    connectMilestone: 0,
    syncMilestone: 3,
    requiredSettings: ['LUNCHFLOW_API_KEY'],
    scopes: [],
    scopesVerified: true,
  },
  whoop: {
    provider: 'whoop',
    displayName: 'WHOOP',
    provides: 'Recovery, sleep, strain (cycles) and workouts.',
    group: 'health',
    authKind: 'oauth',
    multiAccount: false,
    connectMilestone: 3,
    syncMilestone: 3,
    requiredSettings: ['WHOOP_CLIENT_ID', 'WHOOP_CLIENT_SECRET'],
    // Not yet checked against developer.whoop.com (unreachable from the build container).
    scopes: ['offline', 'read:recovery', 'read:cycles', 'read:sleep', 'read:workout'],
    scopesVerified: false,
  },
  spotify: {
    provider: 'spotify',
    displayName: 'Spotify',
    provides: 'Artists you actually listen to (top artists and recent plays) and their new releases.',
    group: 'interests',
    authKind: 'oauth',
    multiAccount: false,
    connectMilestone: 3,
    syncMilestone: 3,
    requiredSettings: ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET'],
    // Named in the brief; re-check at Milestone 3.
    scopes: ['user-top-read', 'user-read-recently-played'],
    scopesVerified: false,
  },
  football_data: {
    provider: 'football_data',
    displayName: 'football-data.org',
    provides: 'Liverpool, Premier League and Champions League fixtures, results and standings (free tier is delayed).',
    group: 'interests',
    authKind: 'api_key',
    multiAccount: false,
    connectMilestone: 3,
    syncMilestone: 3,
    requiredSettings: ['FOOTBALL_DATA_TOKEN'],
    scopes: [],
    scopesVerified: true,
  },
  rss: {
    provider: 'rss',
    displayName: 'News feeds (RSS/Atom)',
    provides: 'Financial news, AI updates and football news from feeds you choose.',
    group: 'interests',
    authKind: 'none',
    multiAccount: false,
    connectMilestone: 3,
    syncMilestone: 3,
    requiredSettings: [],
    scopes: [],
    scopesVerified: true,
  },
}

/** Every provider, in catalog order. */
export function connectionProviders(): ConnectionProviderInfo[] {
  return PROVIDERS.map((p) => CONNECTION_PROVIDER_INFO[p])
}

export function connectionProviderInfo(provider: Provider): ConnectionProviderInfo {
  return CONNECTION_PROVIDER_INFO[provider]
}

/** Providers whose accounts are connected through the server OAuth flow in this milestone. */
export const OAUTH_CONNECT_PROVIDERS = ['google', 'microsoft'] as const
export type OAuthConnectProvider = (typeof OAUTH_CONNECT_PROVIDERS)[number]

export function isOAuthConnectProvider(value: unknown): value is OAuthConnectProvider {
  return (OAUTH_CONNECT_PROVIDERS as readonly unknown[]).includes(value)
}

/** Settings from `requiredSettings` that are missing or blank in `env`. */
export function missingConnectionSettings(
  provider: Provider,
  env: (name: string) => string | undefined,
): string[] {
  return CONNECTION_PROVIDER_INFO[provider].requiredSettings.filter((name) => {
    const v = env(name)
    return v === undefined || v.trim() === ''
  })
}
