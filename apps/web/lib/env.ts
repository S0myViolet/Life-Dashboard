/**
 * Server configuration. Values come from the owner's environment (Vercel
 * project settings / .env.local) and never from committed files.
 *
 * Core settings are required for the app to run. Integration settings are
 * optional: when missing, that connection shows `needs_setup` instead of failing.
 */
import 'server-only'
import { z } from 'zod'
import { normalizeAppUrl, normalizeSupabaseUrl } from '@/lib/config-urls'

const optional = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional()

const CoreEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().transform((v, ctx) => {
    const url = normalizeSupabaseUrl(v)
    if (!url) {
      ctx.addIssue({
        code: 'custom',
        message: 'use the project URL, e.g. https://<project-ref>.supabase.co (no /rest/v1)',
      })
      return z.NEVER
    }
    return url
  }),
  /** Supabase publishable key (sb_publishable_...) or legacy anon key. Safe for browsers. */
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  /** Supabase secret key (sb_secret_...) or legacy service_role key. Server only. */
  SUPABASE_SECRET_KEY: z.string().min(20),
  /** Postgres URL. On Vercel use the Supavisor transaction pooler (port 6543). */
  DATABASE_URL: z
    .string()
    .regex(
      /^postgres(ql)?:\/\/[^\s/]+@[^\s/]+:\d+\/\S+$/,
      'use the full postgresql://… address from Supabase → Connect → Transaction pooler, with your password filled in',
    ),
  /** The only Google account allowed to own the dashboard. */
  OWNER_EMAIL: z.email().transform((v) => v.toLowerCase()),
  /** Canonical public origin, e.g. https://home.example.com. Used for OAuth redirect URIs. */
  APP_URL: z.string().transform((v, ctx) => {
    const url = normalizeAppUrl(v)
    if (!url) {
      ctx.addIssue({
        code: 'custom',
        message:
          "use your app's own address, e.g. https://your-app.vercel.app (no path, not a placeholder)",
      })
      return z.NEVER
    }
    return url
  }),
  /** 32 random bytes, base64. Encrypts provider refresh tokens at rest. */
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
})

export type CoreEnv = z.infer<typeof CoreEnvSchema>

let cached: CoreEnv | undefined

export interface ConfigProblem {
  /** Setting name (never its value). */
  name: string
  hint: string
}

/** What is wrong with the core settings, by name and hint only. Empty when all is well. */
export function coreEnvProblems(env: NodeJS.ProcessEnv = process.env): ConfigProblem[] {
  const parsed = CoreEnvSchema.safeParse(env)
  if (parsed.success) return []
  const byName = new Map<string, string>()
  for (const issue of parsed.error.issues) {
    const name = String(issue.path[0])
    if (byName.has(name)) continue
    const missing = env[name] === undefined || env[name] === ''
    byName.set(name, missing ? 'not set' : issue.message)
  }
  return [...byName].map(([name, hint]) => ({ name, hint }))
}

/** Required core configuration. Throws a readable error listing names and hints (never values). */
export function coreEnv(): CoreEnv {
  if (cached) return cached
  const parsed = CoreEnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const problems = coreEnvProblems()
      .map((p) => `${p.name} (${p.hint})`)
      .join('; ')
    throw new Error(`Missing or invalid server configuration: ${problems}. See .env.example.`)
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
