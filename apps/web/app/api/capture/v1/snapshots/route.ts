/**
 * POST /api/capture/v1/snapshots — one versioned (v1) page snapshot of a
 * selected, active conversation. Reconciled without ever deleting messages.
 */
import { handleSnapshot } from '@/lib/capture/routes'

export function POST(request: Request): Promise<Response> {
  return handleSnapshot(request)
}
