/**
 * Chrome helper authentication for /api/capture/v1/*.
 *
 *   401 — no token, malformed token, unknown or revoked token (who are you?)
 *   403 — valid token but the request's Origin is not the extension origin
 *         recorded when the device was paired (you may not do this from here)
 *
 * Browsers always send Origin on POST; for the read-only selection GET a missing
 * Origin is accepted (Chrome may omit it for extension GETs to permitted hosts),
 * but a present, different Origin is refused.
 */
import 'server-only'
import { timingSafeEqual } from '@personal-home/core'
import { captureVerifyDeviceToken, type CaptureDevice, type Tx } from '@personal-home/db'
import { errorResponse } from './http'

export type DeviceAuthResult = { ok: true; device: CaptureDevice } | { ok: false; response: Response }

const BEARER_RE = /^Bearer ([A-Za-z0-9_-]{1,128})$/

export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const match = BEARER_RE.exec(header.trim())
  return match ? match[1]! : null
}

const unauthorized = (error: string) =>
  errorResponse(401, error, {}, { 'WWW-Authenticate': 'Bearer realm="capture"' })

export async function authenticateDevice(
  tx: Tx,
  request: Request,
  options: { requireOrigin: boolean },
): Promise<DeviceAuthResult> {
  const token = bearerToken(request)
  if (!token) return { ok: false, response: unauthorized('missing_token') }
  const device = await captureVerifyDeviceToken(tx, token)
  if (!device) return { ok: false, response: unauthorized('invalid_token') }

  const origin = request.headers.get('origin')
  if (origin === null) {
    if (options.requireOrigin) return { ok: false, response: errorResponse(403, 'origin_required') }
  } else if (!timingSafeEqual(origin, device.extensionOrigin)) {
    return { ok: false, response: errorResponse(403, 'origin_mismatch') }
  }
  return { ok: true, device }
}
