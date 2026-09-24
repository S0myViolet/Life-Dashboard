/**
 * GET /api/connections/{google,microsoft}/start[?account=<connection id>]
 * Owner only. Starts the provider consent flow (state + PKCE) and redirects to it.
 * `account` pre-fills the account picker when reconnecting a known account.
 */
import type { NextRequest } from 'next/server'
import { connectStart } from '@/lib/integrations/oauth-routes'

export async function GET(request: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params
  return connectStart(request, provider)
}
