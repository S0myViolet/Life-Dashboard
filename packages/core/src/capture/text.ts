/**
 * Text normalization, content hashing and message keys for captured messages.
 */
import { sha256Hex } from '../crypto/secrets.ts'
import type { CaptureRole } from './constants.ts'

/**
 * Normalize rendered text so the same message rendered twice hashes the same:
 * NFC, LF line endings, no zero-width characters, no trailing whitespace per line,
 * at most one blank line in a row, trimmed.
 */
export function captureNormalizeText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[ \t\u00A0]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** sha256 hex of already-normalized text (domain-separated). */
export function captureContentHash(normalizedText: string): Promise<string> {
  return sha256Hex(`ph-capture-v1\n${normalizedText}`)
}

/**
 * Valid message keys: provider message ids (ChatGPT data-message-id / data-turn-id)
 * or derived keys ('d:…', 'h:…'). Kept here, away from the zod schemas, so the
 * Chrome helper's content scripts can use it without bundling zod.
 */
export const CAPTURE_MESSAGE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,199}$/

/** Keys the helper or the server derived (not a provider message id). */
export function captureIsDerivedKey(key: string): boolean {
  return /^[dh]:/.test(key)
}

/**
 * Content-derived fallback key, used only when the page exposed neither a
 * message id nor a thread position: 'h:<first 32 hex of sha256(role, text)>:<n>'
 * where n counts identical (role, text) pairs earlier in the same snapshot.
 * Consequence: an edit to such a message is stored as a new message, not a version.
 */
export async function captureContentDerivedKey(
  role: CaptureRole,
  normalizedText: string,
  occurrence: number,
): Promise<string> {
  const digest = await sha256Hex(`ph-capture-key-v1\n${role}\n${normalizedText}`)
  return `h:${digest.slice(0, 32)}:${occurrence}`
}

/**
 * Position-derived key for Claude rows ([data-index]), built by the helper:
 * 'd:<row index>:<role>:<n>' where n is the ordinal of that role inside the row.
 * An edited message keeps its position, so it becomes a new version of the same key.
 */
export function capturePositionKey(rowIndex: number, role: CaptureRole, ordinal: number): string {
  return `d:${rowIndex}:${role}:${ordinal}`
}
