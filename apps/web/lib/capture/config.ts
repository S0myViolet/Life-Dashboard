import 'server-only'

/** APP_URL's origin when it is configured and valid, otherwise null. */
export function captureConfiguredDashboardOrigin(): string | null {
  const configured = process.env.APP_URL?.trim()
  if (!configured) return null
  try {
    const url = new URL(configured)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    // coreEnv() reports the misconfiguration elsewhere.
    return null
  }
}

/**
 * The dashboard's canonical origin, returned to the helper at pairing so it
 * knows exactly where to send captures. APP_URL when configured; otherwise
 * the origin the request reached (local development).
 */
export function captureDashboardOrigin(request: Request): string {
  return captureConfiguredDashboardOrigin() ?? new URL(request.url).origin
}
