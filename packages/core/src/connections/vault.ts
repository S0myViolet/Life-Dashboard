/**
 * Token vault conventions: every stored secret is an AES-256-GCM envelope whose
 * additional authenticated data names the row and purpose it belongs to, so a
 * ciphertext copied to another connection or column fails to decrypt.
 */
import {
  decryptSecret,
  encryptSecret,
  importEncryptionKey,
  type EncryptionKey,
} from '../crypto/index.ts'
import { ConnectionError, connectionFailure } from './errors.ts'

export type ConnectionTokenKind = 'refresh_token' | 'access_token'

/** Current key version for TOKEN_ENCRYPTION_KEY. Bump together with a re-encryption job when rotating. */
export const CONNECTION_TOKEN_KEY_VERSION = 1

export function connectionTokenContext(connectionId: string, kind: ConnectionTokenKind): string {
  return `connection:${connectionId}:${kind}`
}

export function oauthStateVerifierContext(stateHash: string): string {
  return `oauth_state:${stateHash}:code_verifier`
}

export function connectionEncryptToken(
  key: EncryptionKey,
  connectionId: string,
  kind: ConnectionTokenKind,
  value: string,
): Promise<string> {
  return encryptSecret(value, key, connectionTokenContext(connectionId, kind))
}

/** Decrypt a stored token; failure is a configuration problem (wrong or rotated key), never a crash. */
export async function connectionDecryptToken(
  keys: EncryptionKey | EncryptionKey[],
  connectionId: string,
  kind: ConnectionTokenKind,
  envelope: string,
): Promise<string> {
  try {
    return await decryptSecret(envelope, keys, connectionTokenContext(connectionId, kind))
  } catch {
    throw new ConnectionError(
      connectionFailure(
        'config',
        'decrypt_failed',
        'Stored tokens could not be decrypted with the configured TOKEN_ENCRYPTION_KEY. Restore the key or reconnect the account.',
      ),
    )
  }
}

/** Import TOKEN_ENCRYPTION_KEY; returns null when it is missing or not 32 bytes of base64. */
export async function connectionEncryptionKey(
  base64: string | undefined,
): Promise<EncryptionKey | null> {
  if (!base64 || base64.trim() === '') return null
  try {
    return await importEncryptionKey(base64, CONNECTION_TOKEN_KEY_VERSION)
  } catch {
    return null
  }
}
