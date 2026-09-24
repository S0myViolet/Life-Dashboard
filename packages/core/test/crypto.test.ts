import { describe, expect, it } from 'vitest'
import {
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  decryptSecret,
  encryptSecret,
  importEncryptionKey,
  randomBytes,
  randomToken,
  sha256Hex,
  timingSafeEqual,
} from '../src/index.ts'

const keyB64 = bytesToBase64(new Uint8Array(32).map((_, i) => i))
const otherB64 = bytesToBase64(new Uint8Array(32).map((_, i) => 255 - i))

describe('encoding', () => {
  it('round-trips base64url including edge lengths', () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33, 1000]) {
      const bytes = randomBytes(n)
      expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes)
    }
    expect(() => base64UrlToBytes('not+url/safe=')).toThrow()
  })
})

describe('tokens and hashes', () => {
  it('produces 256-bit url-safe tokens that differ', () => {
    const a = randomToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomToken()).not.toBe(a)
  })

  it('hashes with SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('compares secrets without early exit semantics', () => {
    expect(timingSafeEqual('secret', 'secret')).toBe(true)
    expect(timingSafeEqual('secret', 'secreT')).toBe(false)
    expect(timingSafeEqual('secret', 'secret-longer')).toBe(false)
    expect(timingSafeEqual('', '')).toBe(true)
  })
})

describe('secret envelopes', () => {
  it('encrypts, decrypts, and binds the context', async () => {
    const key = await importEncryptionKey(keyB64)
    const env = await encryptSecret('refresh-token-value', key, 'connection:1:refresh_token')
    expect(env).toMatch(/^v1\./)
    expect(env).not.toContain('refresh-token-value')
    expect(await decryptSecret(env, key, 'connection:1:refresh_token')).toBe('refresh-token-value')
    await expect(decryptSecret(env, key, 'connection:2:refresh_token')).rejects.toThrow(
      'could not be decrypted',
    )
  })

  it('uses a fresh IV each time', async () => {
    const key = await importEncryptionKey(keyB64)
    const a = await encryptSecret('same', key, 'ctx')
    const b = await encryptSecret('same', key, 'ctx')
    expect(a).not.toBe(b)
  })

  it('detects tampering and wrong keys', async () => {
    const key = await importEncryptionKey(keyB64)
    const other = await importEncryptionKey(otherB64)
    const env = await encryptSecret('value', key, 'ctx')
    const parts = env.split('.')
    const ct = base64UrlToBytes(parts[2]!)
    ct[0] = ct[0]! ^ 1
    const tampered = `${parts[0]}.${parts[1]}.${bytesToBase64Url(ct)}`
    await expect(decryptSecret(tampered, key, 'ctx')).rejects.toThrow('could not be decrypted')
    await expect(decryptSecret(env, other, 'ctx')).rejects.toThrow('could not be decrypted')
    await expect(decryptSecret('garbage', key, 'ctx')).rejects.toThrow('malformed')
  })

  it('supports key rotation by version', async () => {
    const v1 = await importEncryptionKey(keyB64, 1)
    const v2 = await importEncryptionKey(otherB64, 2)
    const old = await encryptSecret('old', v1, 'ctx')
    const fresh = await encryptSecret('new', v2, 'ctx')
    expect(await decryptSecret(old, [v2, v1], 'ctx')).toBe('old')
    expect(await decryptSecret(fresh, [v2, v1], 'ctx')).toBe('new')
    await expect(decryptSecret(fresh, [v1], 'ctx')).rejects.toThrow(
      'no decryption key for version 2',
    )
  })

  it('rejects keys of the wrong size', async () => {
    await expect(importEncryptionKey(bytesToBase64(new Uint8Array(16)))).rejects.toThrow('32 bytes')
  })
})
