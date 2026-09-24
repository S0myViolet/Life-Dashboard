/**
 * Shared setup for the connections tests: a real test database, a real
 * encryption key and scripted provider endpoints.
 *
 * Provider responses are SYNTHETIC FIXTURES (not captured from the live
 * service), shaped from docs/research/oauth.md; see
 * packages/integrations/test/fixtures.
 */
import { randomBytes } from 'node:crypto'
import { bytesToBase64, connectionEncryptionKey, type EncryptionKey } from '@personal-home/core'
import { createTestDatabase, seedOwner, type TestDatabase } from '@personal-home/db/testing'
import type { OwnerClaims } from '@personal-home/db'
// Brings in the vitest `ProvidedContext` augmentation (templateDb) for type-checking.
import type {} from '../../../packages/db/test/global-setup.ts'
import {
  createFakeFetch,
  jsonResponse,
  type FakeHandler,
  type RecordedRequest,
} from '../../../packages/integrations/test/fixtures/fake-fetch.ts'
import {
  GOOGLE_TEST_CLIENT,
  gmailProfile,
  googleExchangeResponse,
} from '../../../packages/integrations/test/fixtures/google.ts'
import {
  MICROSOFT_TEST_CLIENT,
  msExchangeResponse,
  msMePersonal,
} from '../../../packages/integrations/test/fixtures/microsoft.ts'

export { createFakeFetch, jsonResponse, type FakeHandler, type RecordedRequest }

export const APP_URL = 'https://home.example.test'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const GMAIL_PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile'
export const CALENDAR_LIST_PREFIX = 'https://www.googleapis.com/calendar/v3/users/me/calendarList'
export const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
export const GRAPH_ME_PREFIX = 'https://graph.microsoft.com/v1.0/me'

export interface ConnectionsTestEnv {
  t: TestDatabase
  owner: OwnerClaims
  key: EncryptionKey
  keyB64: string
  settings: Record<string, string | undefined>
  setting: (name: string) => string | undefined
}

export async function setupConnectionsTest(): Promise<ConnectionsTestEnv> {
  const t = await createTestDatabase()
  const owner = await seedOwner(t.db)
  const keyB64 = bytesToBase64(new Uint8Array(randomBytes(32)))
  const key = (await connectionEncryptionKey(keyB64))!
  const settings: Record<string, string | undefined> = {
    GOOGLE_OAUTH_CLIENT_ID: GOOGLE_TEST_CLIENT.clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: GOOGLE_TEST_CLIENT.clientSecret,
    MICROSOFT_CLIENT_ID: MICROSOFT_TEST_CLIENT.clientId,
    MICROSOFT_CLIENT_SECRET: MICROSOFT_TEST_CLIENT.clientSecret,
  }
  return { t, owner, key, keyB64, settings, setting: (name) => settings[name] }
}

/** Core settings coreEnv() requires, for tests that go through lib/env. Values are dummies. */
export function coreTestEnv(databaseUrl: string, keyB64: string): Record<string, string> {
  return {
    NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic-project.supabase.example.test',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic_000000000000',
    SUPABASE_SECRET_KEY: 'sb_secret_synthetic_0000000000000000',
    DATABASE_URL: databaseUrl,
    OWNER_EMAIL: 'owner@example.com',
    APP_URL,
    TOKEN_ENCRYPTION_KEY: keyB64,
  }
}

export interface ProviderScript {
  googleToken?: (req: RecordedRequest) => Response
  gmailProfile?: (req: RecordedRequest) => Response
  calendarList?: (req: RecordedRequest) => Response
  googleRevoke?: (req: RecordedRequest) => Response
  msToken?: (req: RecordedRequest) => Response
  graphMe?: (req: RecordedRequest) => Response
}

/** Scripted Google + Microsoft endpoints; anything unscripted is a 404 the test will notice. */
export function providerFetch(now: () => Date, script: ProviderScript = {}) {
  const handler: FakeHandler = (req) => {
    if (req.url === GOOGLE_TOKEN_URL)
      return script.googleToken?.(req) ?? jsonResponse(googleExchangeResponse(now()))
    if (req.url === GMAIL_PROFILE_URL)
      return script.gmailProfile?.(req) ?? jsonResponse(gmailProfile)
    if (req.url.startsWith(CALENDAR_LIST_PREFIX))
      return script.calendarList?.(req) ?? jsonResponse({ items: [] })
    if (req.url === GOOGLE_REVOKE_URL)
      return script.googleRevoke?.(req) ?? new Response('', { status: 200 })
    if (req.url === MS_TOKEN_URL) return script.msToken?.(req) ?? jsonResponse(msExchangeResponse())
    if (req.url.startsWith(GRAPH_ME_PREFIX))
      return script.graphMe?.(req) ?? jsonResponse(msMePersonal)
    return new Response('unexpected request in test', { status: 404 })
  }
  return createFakeFetch(handler)
}
