/**
 * Strict conversation URL validation for chatgpt.com and claude.ai.
 *
 * URL shapes come from docs/research/chat-dom.md (open-source exporters, 2025-2026):
 *   ChatGPT: https://chatgpt.com/c/<uuid>
 *            https://chatgpt.com/g/<gpt or project id>[-<slug>]/c/<uuid>   (custom GPTs, projects g-p-...)
 *   Claude:  https://claude.ai/chat/<uuid>
 *            https://claude.ai/project/<uuid>/chat/<uuid>                  (unverified nesting; accepted)
 * Share links, temporary chats, other hosts, ports, credentials and non-https are rejected.
 */
import type { CaptureProvider } from './constants.ts'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const CAPTURE_UUID_RE = new RegExp(`^${UUID}$`, 'i')

const HOSTS: Record<string, CaptureProvider> = {
  'chatgpt.com': 'chatgpt',
  'claude.ai': 'claude',
}

interface PathRule {
  re: RegExp
  /** Capture group holding the conversation UUID. */
  group: number
}

const PATHS: Record<CaptureProvider, PathRule[]> = {
  chatgpt: [
    { re: new RegExp(`^/c/(${UUID})/?$`, 'i'), group: 1 },
    {
      re: new RegExp(`^/g/g-(?:p-)?[A-Za-z0-9]{1,64}(?:-[A-Za-z0-9_.~%-]{1,200})?/c/(${UUID})/?$`, 'i'),
      group: 1,
    },
  ],
  claude: [
    { re: new RegExp(`^/chat/(${UUID})/?$`, 'i'), group: 1 },
    { re: new RegExp(`^/project/(${UUID})/chat/(${UUID})/?$`, 'i'), group: 2 },
  ],
}

export interface CaptureConversationRef {
  provider: CaptureProvider
  /** Lowercase UUID taken from the URL path. */
  externalId: string
  /** https + exact host + path, without query, fragment or trailing slash. UUIDs lowercased. */
  canonicalUrl: string
}

export function captureProviderForHost(hostname: string): CaptureProvider | null {
  return HOSTS[hostname] ?? null
}

/** Parse a conversation URL. Returns null for anything that is not a selectable conversation. */
export function captureParseConversationUrl(input: string): CaptureConversationRef | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (raw.length === 0 || raw.length > 2048) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password || url.port) return null
  const provider = captureProviderForHost(url.hostname)
  if (!provider) return null
  if (provider === 'chatgpt' && url.searchParams.get('temporary-chat') === 'true') return null

  for (const rule of PATHS[provider]) {
    const match = rule.re.exec(url.pathname)
    if (!match) continue
    const externalId = match[rule.group]!.toLowerCase()
    const path = url.pathname
      .replace(/\/$/, '')
      .replace(new RegExp(UUID, 'gi'), (id) => id.toLowerCase())
    return { provider, externalId, canonicalUrl: `https://${url.hostname}${path}` }
  }
  return null
}
