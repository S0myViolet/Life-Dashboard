/**
 * Normalise the two URLs the owner pastes during setup. Pure (no server-only) so proxy.ts,
 * env.ts and the login page agree. Returns null when the value cannot be used.
 */

function parse(raw: string | undefined): URL | null {
  if (!raw) return null
  try {
    return new URL(raw.trim())
  } catch {
    return null
  }
}

const isLocal = (u: URL) => u.hostname === 'localhost' || u.hostname === '127.0.0.1'

/**
 * The Supabase project URL, e.g. https://abc.supabase.co. The dashboard also shows the REST
 * endpoint (…/rest/v1/); that common paste is accepted and trimmed back to the project URL.
 */
export function normalizeSupabaseUrl(raw: string | undefined): string | null {
  const u = parse(raw)
  if (!u || (u.protocol !== 'https:' && !isLocal(u)) || u.search || u.hash) return null
  const path = u.pathname.replace(/\/+$/, '')
  if (path !== '' && path !== '/rest/v1') return null
  return u.origin
}

/** Reserved documentation domains (RFC 2606) that mean APP_URL was never filled in. */
const PLACEHOLDER_HOSTS = /(^|\.)example\.(com|org|net)$/i

/** The app's public origin, e.g. https://home.example.app, with no path or trailing slash. */
export function normalizeAppUrl(raw: string | undefined): string | null {
  const u = parse(raw)
  if (!u || (u.protocol !== 'https:' && !isLocal(u)) || u.search || u.hash) return null
  if (u.pathname.replace(/\/+$/, '') !== '') return null
  if (PLACEHOLDER_HOSTS.test(u.hostname)) return null
  return u.origin
}
