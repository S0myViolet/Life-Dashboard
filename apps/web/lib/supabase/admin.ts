import 'server-only'
import { createClient } from '@supabase/supabase-js'
import { coreEnv } from '@/lib/env'

/** Service client for Auth admin and private Storage. Never import from client components. */
export function createSupabaseAdminClient() {
  const env = coreEnv()
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
