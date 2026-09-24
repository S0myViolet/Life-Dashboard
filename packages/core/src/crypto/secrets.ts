/**
 * Secret handling shared by the web server, jobs and the capture endpoint.
 * WebCrypto only, so it runs in Node 22, browsers and Deno.
 */
import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  fromUtf8,
  utf8,
} from './encoding.ts'

const subtle = () => {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('WebCrypto is not available in this runtime')
  return s
}

/** Cryptographically random bytes. */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length)
  globalThis.crypto.getRandomValues(out)
  return out
}

/** URL-safe random token, e.g. capture tokens and OAuth state. 32 bytes = 256 bits. */
export function randomToken(bytes = 32): string {
  return bytesToBase64Url(randomBytes(bytes))
}

/** SHA-256 as lowercase hex. Store hashes of bearer tokens and one-time codes, never the values. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? utf8(input) : input
  const digest = await subtle().digest('SHA-256', data as BufferSource)
  return bytesToHex(new Uint8Array(digest))
}

/** Constant-time comparison for equal-length secrets (e.g. dispatcher secret header). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = utf8(a)
  const bb = utf8(b)
  let diff = ab.length ^ bb.length
  const len = Math.max(ab.length, bb.length)
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  return diff === 0
}

export interface EncryptionKey {
  version: number
  key: CryptoKey
}

/** Import a 32-byte base64 key (TOKEN_ENCRYPTION_KEY) as an AES-256-GCM key. */
export async function importEncryptionKey(base64Key: string, version = 1): Promise<EncryptionKey> {
  const raw = base64ToBytes(base64Key.trim())
  if (raw.length !== 32) throw new Error('encryption key must be 32 bytes (base64)')
  if (!Number.isInteger(version) || version < 1)
    throw new Error('key version must be a positive integer')
  const key = await subtle().importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
  return { version, key }
}

/**
 * Encrypt a secret. `context` is bound as additional authenticated data, so a
 * ciphertext copied to another row/purpose fails to decrypt
 * (e.g. `connection:<id>:refresh_token`).
 *
 * Envelope: `v<version>.<iv base64url>.<ciphertext+tag base64url>`
 */
export async function encryptSecret(
  plaintext: string,
  key: EncryptionKey,
  context: string,
): Promise<string> {
  const iv = randomBytes(12)
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: utf8(context) as BufferSource },
    key.key,
    utf8(plaintext) as BufferSource,
  )
  return `v${key.version}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ct))}`
}

/** Decrypt an envelope with whichever of `keys` matches its version (supports key rotation). */
export async function decryptSecret(
  envelope: string,
  keys: EncryptionKey | EncryptionKey[],
  context: string,
): Promise<string> {
  const match = /^v(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(envelope)
  if (!match) throw new Error('malformed secret envelope')
  const version = Number(match[1])
  const key = (Array.isArray(keys) ? keys : [keys]).find((k) => k.version === version)
  if (!key) throw new Error(`no decryption key for version ${version}`)
  try {
    const pt = await subtle().decrypt(
      {
        name: 'AES-GCM',
        iv: base64UrlToBytes(match[2]!) as BufferSource,
        additionalData: utf8(context) as BufferSource,
      },
      key.key,
      base64UrlToBytes(match[3]!) as BufferSource,
    )
    return fromUtf8(new Uint8Array(pt))
  } catch {
    // Never include ciphertext or context details in the message.
    throw new Error('secret could not be decrypted')
  }
}
