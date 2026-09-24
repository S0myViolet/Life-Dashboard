import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claimOwner, isOwner, withOwner, withService } from '../src/index.ts'
import {
  createAuthUser,
  createTestDatabase,
  seedOwner,
  withAnon,
  type TestDatabase,
} from './harness.ts'

let t: TestDatabase

beforeAll(async () => {
  t = await createTestDatabase()
})
afterAll(async () => {
  await t?.drop()
})

describe('owner identity', () => {
  it('first verified owner claims, same user re-confirms, a different user is rejected', async () => {
    const owner = await createAuthUser(t.db, 'owner@example.com')
    const other = await createAuthUser(t.db, 'someone@example.com')
    expect(await withService(t.db, (tx) => claimOwner(tx, owner.sub, 'Owner@Example.com'))).toBe(
      'claimed',
    )
    expect(await withService(t.db, (tx) => claimOwner(tx, owner.sub, 'owner@example.com'))).toBe(
      'already_owner',
    )
    expect(await withService(t.db, (tx) => claimOwner(tx, other.sub, 'someone@example.com'))).toBe(
      'rejected',
    )

    expect(await withOwner(t.db, owner, (tx) => isOwner(tx))).toBe(true)
    expect(await withOwner(t.db, other, (tx) => isOwner(tx))).toBe(false)
  })

  it('authenticated and anon roles cannot call claim_owner or read private.owner', async () => {
    const stranger = await createAuthUser(t.db, 'stranger@example.com')
    await expect(
      withOwner(
        t.db,
        stranger,
        (tx) => tx`select private.claim_owner(${stranger.sub}::uuid, 'x@y.z')`,
      ),
    ).rejects.toThrow(/permission denied/)
    await expect(
      withOwner(t.db, stranger, (tx) => tx`select * from private.owner`),
    ).rejects.toThrow(/permission denied/)
    await expect(withAnon(t.db, (tx) => tx`select * from private.owner`)).rejects.toThrow(
      /permission denied/,
    )
  })
})

describe('owner_settings', () => {
  it('is visible and editable only to the owner, validates timezone', async () => {
    const t2 = await createTestDatabase()
    try {
      const owner = await seedOwner(t2.db)
      const stranger = await createAuthUser(t2.db, 'stranger@example.com')

      const rows = await withOwner(
        t2.db,
        owner,
        (tx) => tx`select timezone from public.owner_settings`,
      )
      expect(rows).toHaveLength(1)
      expect(
        await withOwner(t2.db, stranger, (tx) => tx`select * from public.owner_settings`),
      ).toHaveLength(0)
      await expect(
        withAnon(t2.db, (tx) => tx`select * from public.owner_settings`),
      ).rejects.toThrow(/permission denied/)

      const updated = await withOwner(
        t2.db,
        owner,
        (tx) =>
          tx`update public.owner_settings set timezone = 'America/New_York' returning timezone, updated_at`,
      )
      expect(updated[0]?.timezone).toBe('America/New_York')

      await expect(
        withOwner(
          t2.db,
          owner,
          (tx) => tx`update public.owner_settings set timezone = 'Mars/Olympus'`,
        ),
      ).rejects.toThrow(/invalid IANA timezone/)

      const strangerUpdate = await withOwner(
        t2.db,
        stranger,
        (tx) => tx`update public.owner_settings set timezone = 'UTC' returning 1`,
      )
      expect(strangerUpdate).toHaveLength(0)
    } finally {
      await t2.drop()
    }
  })
})
