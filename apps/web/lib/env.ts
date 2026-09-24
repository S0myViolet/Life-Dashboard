/**
 * Server configuration. Values come from the owner's environment (Vercel
 * project settings / .env.local) and never from committed files.
 *
 * Core settings are required for the app to run. Integration settings are
 * optional: when missing, that connection shows `needs_setup` instead of failing.
 */
import 'server-only'
import { z } from 'zod'

const optional = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional()

const CoreEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  /** Supabase publishable key (sb_publishable_...) or legacy anon key. Safe for browsers. */
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  /** Supabase secret key (sb_secret_...) or legacy service_role key. Server only. */
  SUPABASE_SECRET_KEY: z.string().min(20),
  /** Postgres URL. On Vercel use the Supavisor transaction pooler (port 6543). */
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
  /** The only Google account allowed to own the dashboard. */
  OWNER_EMAIL: z.email().transform((v) => v.toLowerCase()),
  /** Canonical public origin, e.g. https://home.example.com. Used for OAuth redirect URIs. */
  APP_URL: z.url().transform((v) => v.replace(/\/$/, '')),
  /** 32 random bytes, base64. Encrypts provider refresh tokens at rest. */
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
})

export type CoreEnv = z.infer<typeof CoreEnvSchema>

let cached: CoreEnv | undefined

/** Required core configuration. Throws a readable error listing missing names (never values). */
export function coreEnv(): CoreEnv {
  if (cached) return cached
  const parsed = CoreEnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(', ')
    throw new Error(`Missing or invalid server configuration: ${names}. See .env.example.`)
  }
  cached = parsed.data
  return cached
}

/** Optional integration settings. Each group is either complete or treated as absent. */
const IntegrationSchemas = {
  google: z.object({
    GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  }),
  microsoft: z.object({
    MICROSOFT_CLIENT_ID: z.string().min(1),
    MICROSOFT_CLIENT_SECRET: z.string().min(1),
  }),
  lunchflow: z.object({ LUNCHFLOW_API_KEY: z.string().min(1) }),
  whoop: z.object({ WHOOP_CLIENT_ID: z.string().min(1), WHOOP_CLIENT_SECRET: z.string().min(1) }),
  spotify: z.object({
    SPOTIFY_CLIENT_ID: z.string().min(1),
    SPOTIFY_CLIENT_SECRET: z.string().min(1),
  }),
  football_data: z.object({ FOOTBALL_DATA_TOKEN: z.string().min(1) }),
  gemini: z.object({ GEMINI_API_KEY: z.string().min(1) }),
  webpush: z.object({
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().min(20),
    VAPID_PRIVATE_KEY: z.string().min(20),
    VAPID_SUBJECT: z.string().regex(/^(mailto:|https:\/\/)/),
  }),
} as const

export type IntegrationName = keyof typeof IntegrationSchemas
export type IntegrationEnv<K extends IntegrationName> = z.infer<(typeof IntegrationSchemas)[K]>

export function integrationEnv<K extends IntegrationName>(name: K): IntegrationEnv<K> | null {
  const trimmed = Object.fromEntries(
    Object.entries(process.env).map(([k, v]) => [k, optional.parse(v)]),
  )
  const parsed = IntegrationSchemas[name].safeParse(trimmed)
  return parsed.success ? (parsed.data as IntegrationEnv<K>) : null
}

/** Names (not values) of the settings an integration needs. Shown on the Connections screen. */
export function integrationSettingNames(name: IntegrationName): string[] {
  return Object.keys(IntegrationSchemas[name].shape)
}
