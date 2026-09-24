/**
 * POST /api/capture/v1/status — the helper saw a sign-in page, a challenge or
 * an unexpected page structure on a selected conversation. Capture pauses and
 * the last good data is kept until the owner resumes it.
 */
import { handleStatus } from '@/lib/capture/routes'

export function POST(request: Request): Promise<Response> {
  return handleStatus(request)
}
