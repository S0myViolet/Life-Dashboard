/**
 * `dispatcher` Edge Function: the minute job dispatcher (brief §7).
 *
 * Invoked every minute by pg_cron + pg_net (supabase/setup/10_schedule_dispatcher.sql)
 * with the `x-dispatcher-secret` header. verify_jwt is off for this function
 * (supabase/config.toml); the secret check in ../_shared/dispatcher-http.ts is
 * the authentication, so a publishable/anon key alone gets 401.
 *
 * Function secrets / env:
 *   DISPATCHER_SECRET  — set with `supabase secrets set` (same value as the Vault secret)
 *   SUPABASE_DB_URL    — provided by the platform
 *   TOKEN_ENCRYPTION_KEY, GOOGLE_OAUTH_CLIENT_ID/_SECRET, MICROSOFT_CLIENT_ID/_SECRET,
 *   GEMINI_API_KEY     — optional; the same values as the web app. Missing ones leave
 *                        that connection honestly unconfigured.
 */
import { createDb, type Db } from '@personal-home/db'
import { createDefaultJobHandlerRegistry } from '@personal-home/jobs'
import { createDispatcherHttpHandler, DispatcherConfigError } from '../_shared/dispatcher-http.ts'

// One small pool per worker, created on the first authenticated request and
// reused while the worker lives (Supabase: create the client at module scope).
// prepare:false is set by createDb for the transaction pooler.
let db: Db | null = null
function getDb(): Db {
  if (db) return db
  const url = Deno.env.get('SUPABASE_DB_URL')
  if (!url) throw new DispatcherConfigError('SUPABASE_DB_URL')
  db = createDb(url, { max: 2, idleTimeout: 10, applicationName: 'ph-dispatcher' })
  return db
}

// When the runtime is about to stop this worker, abort the running job so the
// dispatcher records it as a retryable failure instead of leaving it to lease expiry.
const shutdown = new AbortController()
addEventListener('beforeunload', () => shutdown.abort())

Deno.serve(
  createDispatcherHttpHandler({
    getSecret: () => Deno.env.get('DISPATCHER_SECRET'),
    getDb,
    handlers: createDefaultJobHandlerRegistry({
      fetch: (input, init) => fetch(input, init),
      env: (name) => Deno.env.get(name),
    }),
    shutdownSignal: shutdown.signal,
  }),
)
