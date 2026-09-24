import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { coreEnv } from '@/lib/env'

/** Supabase client bound to the request cookies. Use for Auth only; data goes through lib/server/db. */
export async function createSupabaseServerClient() {
  // Read request cookies first: this marks the route dynamic before any config check runs.
  const cookieStore = await cookies()
  const env = coreEnv()
  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet)
              cookieStore.set(name, value, options)
          } catch {
            // Called from a Server Component: cookies are read-only there. proxy.ts refreshes sessions.
          }
        },
      },
    },
  )
}
