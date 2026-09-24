import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  captureCreatePairingCode,
  captureListDevices,
  captureLivePairingCodeExpiry,
  captureRedeemPairingCode,
  captureRevokeDevice,
  captureVerifyDeviceToken,
  withService,
} from '../src/index.ts'
import { createTestDatabase, type TestDatabase } from './harness.ts'

const ORIGIN = `chrome-extension://${'abcdefghijklmnop'.repeat(2)}`
let t: TestDatabase

beforeAll(async () => {
  t = await createTestDatabase()
})
afterAll(async () => {
  await t?.drop()
})

const create = () => withService(t.db, (tx) => captureCreatePairingCode(tx))
const redeem = (code: string, extensionOrigin = ORIGIN) =>
  withService(t.db, (tx) => captureRedeemPairingCode(tx, { code, deviceName: 'Laptop', extensionOrigin }))

/** Every text value stored in the private capture tables, for plaintext checks. */
async function privateText(): Promise<string> {
  const rows = await withService(t.db, (tx) => tx`
    select row_to_json(d)::text as j from private.capture_devices d
    union all select row_to_json(c)::text from private.capture_pairing_codes c`)
  return rows.map((r) => String(r.j)).join('\n')
}

describe('pairing codes', () => {
  it('stores only hashes; the code redeems once for a token that is also stored only as a hash', async () => {
    const { code, expiresAt } = await create()
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000)
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000 + 5_000)
    expect(await privateText()).not.toContain(code.replace(/-/g, ''))

    const result = await redeem(code.toLowerCase().replace(/-/g, ' '))
    expect(result.status).toBe('paired')
    if (result.status !== 'paired') return
    expect(result.token).toMatch(/^phc_[A-Za-z0-9_-]{43}$/)

    const stored = await privateText()
    expect(stored).not.toContain(result.token)
    expect(stored).not.toContain(result.token.slice(4))
    const [device] = await withService(t.db, (tx) => tx<{ tokenHash: string; extensionOrigin: string }[]>`
      select token_hash, extension_origin from private.capture_devices where id = ${result.deviceId}`)
    expect(device?.tokenHash).toBe(createHash('sha256').update(result.token).digest('hex'))
    expect(device?.extensionOrigin).toBe(ORIGIN)

    expect(await redeem(code)).toEqual({ status: 'invalid' })
  })

  it('expires after ten minutes', async () => {
    const { code } = await create()
    await withService(t.db, (tx) => tx`
      update private.capture_pairing_codes set expires_at = now() - interval '1 second', created_at = now() - interval '11 minutes'
      where used_at is null`)
    expect(await redeem(code)).toEqual({ status: 'invalid' })
  })

  it('dies after five failed attempts; four failures still allow the right code', async () => {
    let { code } = await create()
    for (let i = 0; i < 4; i++) expect(await redeem('0000-0000-0000')).toEqual({ status: 'invalid' })
    expect((await redeem(code)).status).toBe('paired')

    ;({ code } = await create())
    for (let i = 0; i < 5; i++) expect(await redeem('garbage')).toEqual({ status: 'invalid' })
    expect(await withService(t.db, (tx) => captureLivePairingCodeExpiry(tx))).toBeNull()
    expect(await redeem(code)).toEqual({ status: 'invalid' })
  })

  it('a new code replaces an unused older one', async () => {
    const first = await create()
    const second = await create()
    expect(await redeem(first.code)).toEqual({ status: 'invalid' })
    expect((await redeem(second.code)).status).toBe('paired')
  })

  it('requires a chrome-extension origin', async () => {
    const { code } = await create()
    expect(await redeem(code, 'https://evil.example')).toEqual({ status: 'invalid' })
    expect(await redeem(code, 'chrome-extension://short')).toEqual({ status: 'invalid' })
    expect((await redeem(code)).status).toBe('paired')
  })

  it('concurrent redemptions of one code pair exactly one device', async () => {
    const { code } = await create()
    const before = (await withService(t.db, (tx) => captureListDevices(tx))).length
    const results = await Promise.all(Array.from({ length: 6 }, () => redeem(code)))
    expect(results.filter((r) => r.status === 'paired')).toHaveLength(1)
    expect((await withService(t.db, (tx) => captureListDevices(tx))).length).toBe(before + 1)
  })
})

describe('device tokens', () => {
  it('verifies active tokens, rejects malformed and revoked ones, and tracks last use', async () => {
    const { code } = await create()
    const paired = await redeem(code)
    if (paired.status !== 'paired') throw new Error('pairing failed')

    const device = await withService(t.db, (tx) => captureVerifyDeviceToken(tx, paired.token))
    expect(device).toEqual({ id: paired.deviceId, name: 'Laptop', extensionOrigin: ORIGIN })
    const [seen] = await withService(t.db, (tx) => tx<{ lastSeenAt: Date | null }[]>`
      select last_seen_at from private.capture_devices where id = ${paired.deviceId}`)
    expect(seen?.lastSeenAt).toBeInstanceOf(Date)

    const tampered = `${paired.token.slice(0, -1)}${paired.token.endsWith('A') ? 'B' : 'A'}`
    expect(await withService(t.db, (tx) => captureVerifyDeviceToken(tx, tampered))).toBeNull()
    expect(await withService(t.db, (tx) => captureVerifyDeviceToken(tx, 'phc_short'))).toBeNull()
    expect(await withService(t.db, (tx) => captureVerifyDeviceToken(tx, ''))).toBeNull()

    expect(await withService(t.db, (tx) => captureRevokeDevice(tx, paired.deviceId))).toBe(true)
    expect(await withService(t.db, (tx) => captureRevokeDevice(tx, paired.deviceId))).toBe(false)
    expect(await withService(t.db, (tx) => captureVerifyDeviceToken(tx, paired.token))).toBeNull()

    const listed = await withService(t.db, (tx) => captureListDevices(tx))
    const row = listed.find((d) => d.id === paired.deviceId)
    expect(row?.revokedAt).toBeInstanceOf(Date)
    expect(Object.keys(row!)).not.toContain('tokenHash')
  })
})
