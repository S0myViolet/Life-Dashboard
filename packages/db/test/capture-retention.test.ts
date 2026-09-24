import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  captureIngestSnapshot,
  capturePurgeRawText,
  captureSelectConversation,
  withOwner,
  withService,
} from '../src/index.ts'
import { CHAT_URL, makeSnapshot, thread } from './capture-fixtures.ts'
import { createTestDatabase, seedOwner, type TestDatabase } from './harness.ts'

let t: TestDatabase
beforeAll(async () => {
  t = await createTestDatabase()
  const owner = await seedOwner(t.db)
  await withOwner(t.db, owner, (tx) => captureSelectConversation(tx, { url: CHAT_URL }))
})
afterAll(async () => {
  await t?.drop()
})

const NOW = new Date('2026-09-24T12:00:00.000Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()

describe('capturePurgeRawText', () => {
  it('removes raw text older than 30 days and keeps hashes, metadata and newer text', async () => {
    const all = thread(6)
    await withService(t.db, (tx) => captureIngestSnapshot(tx, makeSnapshot(daysAgo(40), all.slice(0, 4)), { receivedAt: NOW }))
    await withService(t.db, (tx) => captureIngestSnapshot(tx, makeSnapshot(daysAgo(2), all), { receivedAt: NOW }))

    const first = await withService(t.db, (tx) => capturePurgeRawText(tx, { now: NOW, batchSize: 3 }))
    expect(first).toEqual({ purged: 3, more: true })
    const second = await withService(t.db, (tx) => capturePurgeRawText(tx, { now: NOW, batchSize: 3 }))
    expect(second).toEqual({ purged: 1, more: false })

    const rows = await withService(t.db, (tx) => tx<
      { key: string; text: string | null; textPurgedAt: Date | null; contentHash: string; charCount: number }[]
    >`
      select m.message_key as key, v.text, v.text_purged_at, v.content_hash, v.char_count
      from public.captured_message_versions v join public.captured_messages m on m.id = v.message_id
      order by m.order_hint`)
    expect(rows.map((r) => r.text === null)).toEqual([true, true, true, true, false, false])
    for (const r of rows.slice(0, 4)) {
      expect(r.textPurgedAt).toEqual(NOW)
      expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/)
      expect(r.charCount).toBeGreaterThan(0)
    }

    // Seeing the same text again neither restores it nor creates a duplicate version.
    const again = await withService(t.db, (tx) =>
      captureIngestSnapshot(tx, makeSnapshot(new Date(NOW.getTime() - 60_000).toISOString(), all), {
        receivedAt: NOW,
      }),
    )
    expect(again).toMatchObject({ newMessages: 0, newVersions: 0, contentChanged: false })
    const [{ n }] = (await withService(t.db, (tx) => tx`
      select count(*)::int as n from public.captured_message_versions where text is null`)) as unknown as [
      { n: number },
    ]
    expect(n).toBe(4)
  })

  it('validates its options', async () => {
    await expect(withService(t.db, (tx) => capturePurgeRawText(tx, { retentionDays: 0 }))).rejects.toThrow(RangeError)
    await expect(withService(t.db, (tx) => capturePurgeRawText(tx, { batchSize: 1.5 }))).rejects.toThrow(RangeError)
  })
})
