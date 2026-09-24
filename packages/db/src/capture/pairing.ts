/**
 * Chrome helper pairing and device tokens. Service transactions only: these
 * tables live in the `private` schema and hold SHA-256 hashes, never values.
 *
 * Flow: the owner (session-authenticated page) creates a one-time code, which is
 * shown once and expires after 10 minutes. The extension redeems it with a device
 * name; the server records the request's chrome-extension:// origin and returns a
 * bearer token once. Each failed redemption counts against every live code; a code
 * with 5 failed attempts is dead, so a code cannot be brute-forced.
 */
import {
  CAPTURE_EXTENSION_ORIGIN_RE,
  CAPTURE_LIMITS,
  CAPTURE_UUID_RE,
  captureGenerateDeviceToken,
  captureGeneratePairingCode,
  captureHashDeviceToken,
  captureHashPairingCode,
  captureIsDeviceTokenFormat,
  captureNormalizePairingCode,
  timingSafeEqual,
} from '@personal-home/core'
import type { Tx } from '../client.ts'

export interface CapturePairingCode {
  /** Plain code, returned to the owner exactly once. */
  code: string
  expiresAt: Date
}

/** Create a one-time pairing code. Any earlier unused code stops working. */
export async function captureCreatePairingCode(tx: Tx): Promise<CapturePairingCode> {
  const code = captureGeneratePairingCode()
  const codeHash = await captureHashPairingCode(captureNormalizePairingCode(code)!)
  await tx`delete from private.capture_pairing_codes where used_at is null`
  const [row] = await tx<{ expiresAt: Date }[]>`
    insert into private.capture_pairing_codes (code_hash, expires_at)
    values (${codeHash}, now() + make_interval(mins => ${CAPTURE_LIMITS.pairingCodeTtlMinutes}))
    returning expires_at
  `
  if (!row) throw new Error('pairing code insert returned no row')
  return { code, expiresAt: row.expiresAt }
}

export type CaptureRedeemResult =
  | { status: 'paired'; token: string; deviceId: string }
  | { status: 'invalid' }

/**
 * Redeem a pairing code. Single-use (row lock + used_at), expiring, attempt-limited.
 * Returns the device token exactly once; only its hash is stored.
 */
export async function captureRedeemPairingCode(
  tx: Tx,
  input: { code: string; deviceName: string; extensionOrigin: string },
): Promise<CaptureRedeemResult> {
  if (!CAPTURE_EXTENSION_ORIGIN_RE.test(input.extensionOrigin)) return { status: 'invalid' }
  const normalized = captureNormalizePairingCode(input.code)
  const codeHash = normalized ? await captureHashPairingCode(normalized) : null

  const [claimed] = codeHash
    ? await tx<{ id: string }[]>`
        update private.capture_pairing_codes
        set used_at = now()
        where code_hash = ${codeHash}
          and used_at is null
          and expires_at > now()
          and failed_attempts < ${CAPTURE_LIMITS.pairingMaxFailedAttempts}
        returning id
      `
    : []

  if (!claimed) {
    // Count the failure against every live code (normally there is just one).
    await tx`
      update private.capture_pairing_codes
      set failed_attempts = failed_attempts + 1
      where used_at is null and expires_at > now()
    `
    return { status: 'invalid' }
  }

  const token = captureGenerateDeviceToken()
  const tokenHash = await captureHashDeviceToken(token)
  const [device] = await tx<{ id: string }[]>`
    insert into private.capture_devices (name, token_hash, extension_origin)
    values (${input.deviceName.trim()}, ${tokenHash}, ${input.extensionOrigin})
    returning id
  `
  if (!device) throw new Error('device insert returned no row')
  await tx`update private.capture_pairing_codes set device_id = ${device.id} where id = ${claimed.id}`
  return { status: 'paired', token, deviceId: device.id }
}

export interface CaptureDevice {
  id: string
  name: string
  extensionOrigin: string
}

/**
 * Resolve a bearer token to an active device (hash lookup; revoked devices never
 * match). Updates last_seen_at at most once a minute.
 */
export async function captureVerifyDeviceToken(tx: Tx, token: string): Promise<CaptureDevice | null> {
  if (typeof token !== 'string' || !captureIsDeviceTokenFormat(token)) return null
  const tokenHash = await captureHashDeviceToken(token)
  const [row] = await tx<(CaptureDevice & { tokenHash: string })[]>`
    select id, name, extension_origin, token_hash
    from private.capture_devices
    where token_hash = ${tokenHash} and revoked_at is null
  `
  if (!row || !timingSafeEqual(row.tokenHash, tokenHash)) return null
  await tx`
    update private.capture_devices set last_seen_at = now()
    where id = ${row.id} and (last_seen_at is null or last_seen_at < now() - interval '1 minute')
  `
  return { id: row.id, name: row.name, extensionOrigin: row.extensionOrigin }
}

export interface CaptureDeviceRow {
  id: string
  name: string
  extensionOrigin: string
  createdAt: Date
  lastSeenAt: Date | null
  revokedAt: Date | null
}

/** For the owner's settings page (the caller has checked the owner session). No hashes. */
export async function captureListDevices(tx: Tx): Promise<CaptureDeviceRow[]> {
  return tx<CaptureDeviceRow[]>`
    select id, name, extension_origin, created_at, last_seen_at, revoked_at
    from private.capture_devices
    order by revoked_at is not null, created_at desc
  `
}

export async function captureRevokeDevice(tx: Tx, deviceId: string): Promise<boolean> {
  if (!CAPTURE_UUID_RE.test(deviceId)) return false
  const rows = await tx`
    update private.capture_devices set revoked_at = now()
    where id = ${deviceId}::uuid and revoked_at is null
    returning id
  `
  return rows.length > 0
}

/** Live (unused, unexpired, not locked) pairing code expiry, for the settings page. */
export async function captureLivePairingCodeExpiry(tx: Tx): Promise<Date | null> {
  const [row] = await tx<{ expiresAt: Date }[]>`
    select expires_at from private.capture_pairing_codes
    where used_at is null and expires_at > now()
      and failed_attempts < ${CAPTURE_LIMITS.pairingMaxFailedAttempts}
    order by created_at desc limit 1
  `
  return row?.expiresAt ?? null
}
