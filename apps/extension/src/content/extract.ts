/**
 * Shared shapes and helpers for the per-provider DOM extractors.
 *
 * Extractors are pure functions of the current Document: they report what is
 * mounted right now. Long threads are virtualised by both apps (only a window
 * of turns is in the DOM), so the accumulator (accumulator.ts) merges
 * successive observations while the owner scrolls.
 */
import { CAPTURE_MESSAGE_KEY_RE, type CaptureRole } from '@personal-home/core'

export type ExtractStatus =
  /** A conversation thread was recognised. */
  | 'ok'
  /** No thread (yet): the app may still be rendering. */
  | 'loading'
  /** Message markers exist but not in the expected containers. */
  | 'structure_changed'
  | 'signed_out'
  | 'challenge'

export interface ExtractedMessage {
  /** Key sent to the server: provider message/turn id or a Claude position key. */
  key?: string
  /** Identity inside the accumulator (the key, or a content fallback). */
  localKey: string
  role: CaptureRole
  /** Rendered text; empty while a mounted turn has not hydrated yet. */
  text: string
  orderHint?: number
  isStreaming: boolean
}

export interface PageExtract {
  status: ExtractStatus
  /** Mounted messages in DOM order. */
  messages: ExtractedMessage[]
  /** The conversation's first message is mounted and rendered. */
  firstMounted: boolean
  /** The conversation's last message is mounted and rendered. */
  lastMounted: boolean
  streaming: boolean
  title?: string
  /**
   * Thread positions (ChatGPT turn wrapper ids, Claude row indexes) that are
   * mounted and fully rendered in this read: every message in them has text,
   * or they hold only media/attachments, which are never collected.
   */
  renderedPositions: string[]
  /**
   * Every position of the whole thread in order, when this read can tell
   * (ChatGPT's persistent turn wrappers; Claude's aria-setsize, or the rows up
   * to the last one while it is mounted; a single view of the whole thread).
   * null when unknown. Coverage is gap-free only if every one was rendered.
   */
  threadPositions: string[] | null
}

export const emptyExtract = (status: ExtractStatus): PageExtract => ({
  status,
  messages: [],
  firstMounted: false,
  lastMounted: false,
  streaming: false,
  renderedPositions: [],
  threadPositions: null,
})

const MEDIA = 'img, picture, video, audio, canvas, iframe, object'

/**
 * The element shows non-text content (a generated image, an attachment
 * preview) that is never collected as text. Icons in buttons (and SVG icons
 * generally) do not count, so an action bar alone is not "content".
 */
export function hasContentMedia(el: Element): boolean {
  return Array.from(el.querySelectorAll(MEDIA)).some((m) => !m.closest('button, [role="button"]'))
}

export function safeKey(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  return CAPTURE_MESSAGE_KEY_RE.test(value) ? value : undefined
}

export function localKeyFor(key: string | undefined, role: CaptureRole, fallback: string): string {
  return key ?? `local:${role}:${fallback}`
}

/** Scrolled to the top (within a few pixels). */
export function nearTop(el: Element): boolean {
  return el.scrollTop <= 4
}

/** Scrolled to the bottom (within a small margin). */
export function nearBottom(el: Element): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 64
}

/**
 * Cloudflare / bot-check markers. Turnstile renders in a closed shadow root,
 * so only its hidden response input is visible to DOM queries (research notes).
 */
const CHALLENGE_SELECTORS = [
  'input[id^="cf-chl-widget-"]',
  'input[name="cf-turnstile-response"]',
  'iframe[src*="challenges.cloudflare.com"]',
  '#challenge-form',
  '#challenge-running',
  '#cf-challenge-running',
  'script[src*="/cdn-cgi/challenge-platform/"]',
].join(', ')

/** Only meaningful when no conversation is rendered (an invisible widget on a working page is ignored). */
export function looksLikeChallenge(doc: Document): boolean {
  if (/^\s*just a moment/i.test(doc.title)) return true
  return doc.querySelector(CHALLENGE_SELECTORS) !== null
}

export function cleanTitle(raw: string, provider: 'chatgpt' | 'claude'): string | undefined {
  let t = raw.replace(/\s+/g, ' ').trim()
  if (provider === 'chatgpt') t = t.replace(/^ChatGPT\s*[-–|:]\s*/i, '').replace(/\s*[-–|]\s*ChatGPT$/i, '')
  else t = t.replace(/\s*[-–|]\s*Claude$/i, '')
  if (t === '' || /^(ChatGPT|Claude|New chat)$/i.test(t)) return undefined
  return t.slice(0, 500)
}
