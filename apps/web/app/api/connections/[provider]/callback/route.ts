/**
 * GET /api/connections/{google,microsoft}/callback
 * Owner only. Validates and consumes the one-time state, exchanges the code,
 * identifies the account, stores encrypted tokens and redirects back to
 * Settings → Connections with a closed result code. Provider responses are
 * never echoed.
 */
import type { NextRequest } from 'next/server'
import { connectCallback } from '@/lib/integrations/oauth-routes'

export async function GET(request: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params
  return connectCallback(request, provider)
}
