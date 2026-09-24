/**
 * Same-origin check for owner-driven connection changes (server actions).
 *
 * Next.js already rejects a Server Action whose Origin differs from the Host,
 * but it lets a request with NO Origin header through with only a warning
 * (docs/research/nextjs.md). Browsers always send Origin on POST, so pause,
 * resume, rename and disconnect insist on one that matches APP_URL.
 */

/** True when `originHeader` is exactly the origin of `appUrl`. */
export function isSameOriginRequest(
  originHeader: string | null | undefined,
  appUrl: string,
): boolean {
  if (!originHeader || originHeader === 'null') return false
  try {
    const expected = new URL(appUrl).origin
    const given = new URL(originHeader)
    // An Origin header is scheme://host[:port] only; anything else is not a browser Origin.
    if (given.pathname !== '/' || given.search || given.hash || given.username || given.password)
      return false
    return given.origin === expected
  } catch {
    return false
  }
}
