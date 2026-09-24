/**
 * View model for the Connections screen. Pure (no I/O) so it can be tested
 * without Next.js: rows + per-provider setup state in, grouped providers out.
 */
import {
  CONNECTION_GROUPS,
  CONNECTION_GROUP_LABELS,
  CONNECTIONS_CURRENT_MILESTONE,
  connectionProviders,
  connectionScopeCoverage,
  connectionDescribeScope,
  isOAuthConnectProvider,
  type ConnectionGroup,
  type ConnectionProviderInfo,
  type Provider,
  type StoredConnectionStatus,
} from '@personal-home/core'
import type { ConnectionRow } from '@personal-home/db'

export interface ProviderSetupState {
  configured: boolean
  missing: string[]
}

export interface AccountView {
  id: string
  label: string
  status: StoredConnectionStatus
  lastAttemptAt: Date | null
  lastSuccessAt: Date | null
  nextAttemptAt: Date | null
  errorMessage: string | null
  /** Human names of requested access that was not granted. */
  missingAccess: string[]
  /** Neither mail nor calendar access was granted. */
  noDataAccess: boolean
  paused: boolean
  /** Offer "Reconnect": credentials rejected, or some access missing. */
  offerReconnect: boolean
  reconnectHref: string | null
}

export type ProviderAvailability =
  | { kind: 'connectable' }
  | { kind: 'needs_setup'; missing: string[] }
  | { kind: 'api_key_configured' }
  | { kind: 'extension' }
  | { kind: 'later'; milestone: number; missing: string[] }

export interface ProviderView {
  info: ConnectionProviderInfo
  availability: ProviderAvailability
  accounts: AccountView[]
  /** Plain link (never prefetched) that starts the OAuth flow. */
  connectHref: string | null
  setupHref: string
  /** Disconnect can revoke the grant at the provider (Google); Microsoft has no revocation API. */
  supportsRevoke: boolean
}

export interface GroupView {
  group: ConnectionGroup
  label: string
  providers: ProviderView[]
}

export function connectStartHref(provider: Provider, reconnectId?: string): string {
  const base = `/api/connections/${provider}/start`
  return reconnectId ? `${base}?account=${encodeURIComponent(reconnectId)}` : base
}

function accountView(row: ConnectionRow, connectable: boolean): AccountView {
  const coverage = connectionScopeCoverage(row.provider, row.grantedScopes)
  const oauth = isOAuthConnectProvider(row.provider)
  const missingAccess = oauth
    ? coverage.missing
        .filter((s) => !['openid', 'email', 'profile'].includes(s))
        .map(connectionDescribeScope)
    : []
  const offerReconnect = oauth && (row.status === 'needs_reconnect' || missingAccess.length > 0)
  return {
    id: row.id,
    label: row.accountLabel,
    status: row.status,
    lastAttemptAt: row.lastAttemptAt,
    lastSuccessAt: row.lastSuccessAt,
    nextAttemptAt: row.status === 'error' ? row.nextAttemptAt : null,
    errorMessage:
      row.status === 'error' || row.status === 'needs_reconnect' ? row.lastErrorMessage : null,
    missingAccess,
    noDataAccess: oauth && !coverage.mail && !coverage.calendar,
    paused: row.status === 'paused',
    offerReconnect,
    reconnectHref: offerReconnect && connectable ? connectStartHref(row.provider, row.id) : null,
  }
}

function availabilityOf(
  info: ConnectionProviderInfo,
  setup: ProviderSetupState,
): ProviderAvailability {
  if (info.connectMilestone > CONNECTIONS_CURRENT_MILESTONE)
    return {
      kind: 'later',
      milestone: info.connectMilestone,
      missing: setup.configured ? [] : setup.missing,
    }
  if (info.authKind === 'extension') return { kind: 'extension' }
  if (!setup.configured) return { kind: 'needs_setup', missing: setup.missing }
  if (info.authKind === 'api_key') return { kind: 'api_key_configured' }
  return { kind: 'connectable' }
}

export function buildConnectionsView(input: {
  rows: ConnectionRow[]
  setup: (provider: Provider) => ProviderSetupState
}): GroupView[] {
  const byProvider = new Map<Provider, ConnectionRow[]>()
  for (const row of input.rows)
    byProvider.set(row.provider, [...(byProvider.get(row.provider) ?? []), row])

  const providers = connectionProviders().map((info): ProviderView => {
    const availability = availabilityOf(info, input.setup(info.provider))
    const connectable = availability.kind === 'connectable' && isOAuthConnectProvider(info.provider)
    return {
      info,
      availability,
      accounts: (byProvider.get(info.provider) ?? []).map((r) => accountView(r, connectable)),
      connectHref: connectable ? connectStartHref(info.provider) : null,
      setupHref: `/settings/connections/setup#${info.provider}`,
      supportsRevoke: info.provider === 'google',
    }
  })

  return CONNECTION_GROUPS.map((group) => ({
    group,
    label: CONNECTION_GROUP_LABELS[group],
    providers: providers.filter((p) => p.info.group === group),
  })).filter((g) => g.providers.length > 0)
}
