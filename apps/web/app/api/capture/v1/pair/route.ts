/**
 * POST /api/capture/v1/pair — the Chrome helper redeems a one-time code shown in
 * Settings → Chrome helper and receives its device token once.
 * Called from the extension (chrome-extension:// origin), never from a page.
 */
import { handlePair } from '@/lib/capture/routes'

export function POST(request: Request): Promise<Response> {
  return handlePair(request)
}
