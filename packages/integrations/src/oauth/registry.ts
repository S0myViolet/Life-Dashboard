/**
 * Build the OAuth adapter for a provider from server settings, or report which
 * setting NAMES are missing (the connection then shows `needs_setup`).
 * Settings are read through a lookup function so this works with process.env
 * (Next.js, scripts) and Deno.env (Edge Functions) alike.
 */
import {
  missingConnectionSettings,
  type ConnectionOAuthAdapter,
  type OAuthConnectProvider,
} from '@personal-home/core'
import { createGoogleAdapter } from '../google/adapter.ts'
import { createMicrosoftAdapter } from '../microsoft/adapter.ts'

export type OAuthAdapterLookup =
  { ok: true; adapter: ConnectionOAuthAdapter } | { ok: false; missing: string[] }

export function oauthAdapterFromSettings(
  provider: OAuthConnectProvider,
  setting: (name: string) => string | undefined,
): OAuthAdapterLookup {
  const missing = missingConnectionSettings(provider, setting)
  if (missing.length > 0) return { ok: false, missing }
  const get = (name: string) => (setting(name) ?? '').trim()
  switch (provider) {
    case 'google':
      return {
        ok: true,
        adapter: createGoogleAdapter({
          clientId: get('GOOGLE_OAUTH_CLIENT_ID'),
          clientSecret: get('GOOGLE_OAUTH_CLIENT_SECRET'),
        }),
      }
    case 'microsoft':
      return {
        ok: true,
        adapter: createMicrosoftAdapter({
          clientId: get('MICROSOFT_CLIENT_ID'),
          clientSecret: get('MICROSOFT_CLIENT_SECRET'),
          tenant: 'common',
        }),
      }
  }
}
