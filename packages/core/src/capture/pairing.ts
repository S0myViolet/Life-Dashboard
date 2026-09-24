/**
 * One-time pairing codes and device tokens for the Chrome helper.
 * Only hashes are stored; see packages/db/src/capture/pairing.ts.
 */
import { randomBytes, randomToken, sha256Hex } from '../crypto/secrets.ts'

/** Crockford base32: no I, L, O or U, so codes are easy to read and type. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 12

/** 12 random base32 characters (60 bits) shown as XXXX-XXXX-XXXX. */
export function captureGeneratePairingCode(): string {
  const bytes = randomBytes(CODE_LENGTH)
  let out = ''
  // 256 is a multiple of 32, so `& 31` is unbiased.
  for (const b of bytes) out += ALPHABET[b & 31]
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`
}

/**
 * Canonical form of a typed code: uppercase, separators removed, common
 * look-alikes mapped (O→0, I/L→1). Returns null when it cannot be a code.
 */
export function captureNormalizePairingCode(input: string): string | null {
  if (typeof input !== 'string' || input.length > 64) return null
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (cleaned.length !== CODE_LENGTH) return null
  for (const ch of cleaned) if (!ALPHABET.includes(ch)) return null
  return cleaned
}

export function captureHashPairingCode(normalizedCode: string): Promise<string> {
  return sha256Hex(`ph-capture-pair-v1\n${normalizedCode}`)
}

const TOKEN_RE = /^phc_[A-Za-z0-9_-]{43}$/

/** Bearer token for one paired device: 'phc_' + 256 random bits (base64url). */
export function captureGenerateDeviceToken(): string {
  return `phc_${randomToken(32)}`
}

export function captureIsDeviceTokenFormat(token: string): boolean {
  return TOKEN_RE.test(token)
}

export function captureHashDeviceToken(token: string): Promise<string> {
  return sha256Hex(token)
}
