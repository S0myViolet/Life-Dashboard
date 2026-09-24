import 'server-only'

/**
 * The dashboard's canonical origin, returned to the helper at pairing so it
 * knows exactly where to send captures. APP_URL when configured; otherwise
 * the origin the request reached (local development).
 */
export function captureDashboardOrigin(request: Request): string {
  const configured = process.env.APP_URL?.trim()
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // Fall through: coreEnv() reports the misconfiguration elsewhere.
    }
  }
  return new URL(request.url).origin
}
