/**
 * GET /api/capture/v1/selection — the selected, active conversations a paired
 * helper may collect (id, provider, externalId, url, captureState only).
 */
import { handleSelection } from '@/lib/capture/routes'

export function GET(request: Request): Promise<Response> {
  return handleSelection(request)
}
