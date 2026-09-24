/**
 * Server settings for connections: which providers are configured (by setting
 * NAME only — values never leave the server), redirect URIs and the token key.
 */
import 'server-only'
import {
  connectionEncryptionKey,
  type EncryptionKey,
  type OAuthConnectProvider,
  type Provider,
} from '@personal-home/core'
import { coreEnv, integrationEnv, integrationSettingNames, type IntegrationName } from '@/lib/env'

/** Env group in lib/env.ts for providers that need server settings. */
export const PROVIDER_ENV_GROUP: Partial<Record<Provider, IntegrationName>> = {
  google: 'google',
  microsoft: 'microsoft',
  lunchflow: 'lunchflow',
  whoop: 'whoop',
  spotify: 'spotify',
  football_data: 'football_data',
}

export interface ProviderSetup {
  configured: boolean
  /** Names of settings that are missing (all of the group's names when the group is incomplete). */
  missing: string[]
}

export function providerSetup(provider: Provider): ProviderSetup {
  const group = PROVIDER_ENV_GROUP[provider]
  if (!group) return { configured: true, missing: [] }
  if (integrationEnv(group)) return { configured: true, missing: [] }
  const missing = integrationSettingNames(group).filter((name) => (process.env[name] ?? '').trim() === '')
  // A present-but-invalid value still counts as not configured; name the whole group then.
  return { configured: false, missing: missing.length > 0 ? missing : integrationSettingNames(group) }
}

/** Setting lookup for the adapter registry (trimmed; blank counts as unset). */
export function serverSetting(name: string): string | undefined {
  const v = process.env[name]?.trim()
  return v ? v : undefined
}

export function oauthRedirectUri(provider: OAuthConnectProvider, appUrl = coreEnv().APP_URL): string {
  return `${appUrl}/api/connections/${provider}/callback`
}

let cachedKey: Promise<EncryptionKey | null> | undefined

export function tokenEncryptionKey(): Promise<EncryptionKey | null> {
  cachedKey ??= connectionEncryptionKey(coreEnv().TOKEN_ENCRYPTION_KEY)
  return cachedKey
}

export function oauthStateCookieName(provider: OAuthConnectProvider): string {
  return `ph_oauth_${provider}`
}
