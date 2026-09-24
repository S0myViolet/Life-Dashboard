/**
 * The contract every connection adapter implements (brief §6: adapters expose
 * authorize, refresh, sync, status and disconnect; the shared scheduler
 * supplies account identity and saved cursors).
 *
 * Adapters live in @personal-home/integrations and do network I/O only through
 * the injected `fetch`. They never read the database or the environment:
 * credentials, tokens and cursors are passed in, results are returned, and
 * failures are thrown as `ConnectionError` with a classified failure.
 */
import type { DataState, Provider } from '../catalog.ts'

export interface ConnectionAdapterContext {
  fetch: typeof fetch
  /** Cancels in-flight requests (job shutdown, request abort). */
  signal?: AbortSignal
  now: () => Date
}

/** Tokens returned by an authorization-code exchange or a refresh. */
export interface OAuthTokenSet {
  accessToken: string
  /** Absolute expiry computed from `expires_in`; null when the provider did not say. */
  accessTokenExpiresAt: Date | null
  /**
   * Present on the first exchange and whenever the provider rotates it
   * (Microsoft replaces it on every refresh). Null means "keep the one you have".
   */
  refreshToken: string | null
  /** Normalised granted scopes, or null when the response omitted `scope`. */
  grantedScopes: string[] | null
  /** OpenID Connect id token, when returned directly by the token endpoint. */
  idToken: string | null
}

export type ConnectionAccountKind = 'personal' | 'work_or_school' | 'unknown'

/** Who the connected account is. */
export interface ConnectionAccountIdentity {
  /** Stable provider id (Google `sub`, Microsoft Graph user id). Unique per provider. */
  externalAccountId: string
  /** Display label, normally the mailbox address. */
  accountLabel: string
  accountKind: ConnectionAccountKind
}

/** Result of calling a cheap identity endpoint with the current access token. */
export interface ConnectionAccessCheck {
  /** Which endpoint proved access, e.g. `gmail.users.getProfile`, `graph.me`. */
  endpoint: string
  /** Label reported by that endpoint (mailbox address) when it returns one. */
  accountLabel: string | null
  /** Provider id reported by that endpoint, when it returns one (used to detect a mismatch). */
  externalAccountId: string | null
  /** Non-secret facts for verification reports, e.g. `{ historyIdPresent: true }`. Never message content. */
  facts: Record<string, string | number | boolean | null>
}

export type ConnectionRevokeOutcome =
  | 'revoked'
  /** The provider says the token was already invalid. */
  | 'already_invalid'
  /** The provider offers no revocation endpoint (Microsoft); the owner removes consent manually. */
  | 'not_supported'
  | 'failed'

export interface AuthorizeInput {
  state: string
  /** PKCE S256 challenge. */
  codeChallenge: string
  redirectUri: string
  /** Pre-fills the account picker when reconnecting a known account. */
  loginHint?: string
}

export interface ExchangeInput {
  code: string
  codeVerifier: string
  redirectUri: string
}

/** Saved cursor handed to `sync` by the scheduler (Milestone 2). */
export interface ConnectionSyncCursor {
  resourceType: string
  resourceId: string
  cursor: string | null
  windowStart: Date | null
  windowEnd: Date | null
}

export interface ConnectionSyncInput {
  connectionId: string
  externalAccountId: string
  accessToken: string
  grantedScopes: string[]
  cursors: ConnectionSyncCursor[]
}

export interface ConnectionSyncResult {
  cursors: (ConnectionSyncCursor & { status: string })[]
  dataState: DataState
}

export interface ConnectionOAuthAdapter {
  provider: Provider
  /** Whether `revoke` can actually revoke at the provider. */
  supportsRevoke: boolean
  /** Authorization URL for the consent screen (server authorization-code flow with PKCE). */
  authorize(input: AuthorizeInput): string
  exchange(input: ExchangeInput, ctx: ConnectionAdapterContext): Promise<OAuthTokenSet>
  refresh(refreshToken: string, ctx: ConnectionAdapterContext): Promise<OAuthTokenSet>
  /** Identify the account a fresh token set belongs to. */
  identify(tokens: OAuthTokenSet, ctx: ConnectionAdapterContext): Promise<ConnectionAccountIdentity>
  /** Prove background access with a cheap identity call allowed by the granted scopes. */
  verifyAccess(
    accessToken: string,
    grantedScopes: readonly string[],
    ctx: ConnectionAdapterContext,
  ): Promise<ConnectionAccessCheck>
  /** Import data (Milestone 2+). Absent until then. */
  sync?(input: ConnectionSyncInput, ctx: ConnectionAdapterContext): Promise<ConnectionSyncResult>
  /** Revoke the grant at the provider. Best effort: never throws. */
  revoke(token: string, ctx: ConnectionAdapterContext): Promise<ConnectionRevokeOutcome>
}
