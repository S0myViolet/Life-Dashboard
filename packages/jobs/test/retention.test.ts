/**
 * The combined daily retention job against real Postgres: expired journal recordings are
 * deleted and captured chat text older than 30 days is cleared, while newer data stays.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  captureIngestSnapshot,
  captureSelectConversation,
  withOwner,
  withService,
} from '@personal-home/db'
import { createTestDatabase, seedOwner, type TestDatabase } from '@personal-home/db/testing'
import { CHAT_URL, makeSnapshot, thread } from '../../db/test/capture-fixtures.ts'
import { createRetentionPurgeJobHandler } from '../src/index.ts'
import type { JobContext } from '../src/dispatcher/types.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    templateDb: string
  }
}

const NOW = new Date('2026-09-24T02:30:00.000Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000)

let t: TestDatabase
beforeAll(async () => {
  t = await createTestDatabase()
  const owner = await seedOwner(t.db)
  await withOwner(t.db, owner, (tx) => captureSelectConversation(tx, { url: CHAT_URL }))
})
afterAll(async () => {
  await t?.drop()
})

function context(): JobContext {
  return {
    job: {
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'retention.purge',
      payload: {},
    } as JobContext['job'],
    db: t.db,
    now: () => NOW,
    signal: new AbortController().signal,
    workerId: 'test',
    heartbeat: async () => true,
  }
}

describe('retention.purge', () => {
  it('deletes expired recordings and clears chat text older than 30 days, keeping newer data', async () => {
    const messages = thread(4)
    await withService(t.db, (tx) =>
      captureIngestSnapshot(tx, makeSnapshot(daysAgo(40).toISOString(), messages.slice(0, 2)), {
        receivedAt: NOW,
      }),
    )
    await withService(t.db, (tx) =>
      captureIngestSnapshot(tx, makeSnapshot(daysAgo(1).toISOString(), messages), {
        receivedAt: NOW,
      }),
    )

    const [expired, fresh] = await withService(t.db, async (tx) => {
      const [entry] = await tx<{ id: string }[]>`
        insert into public.journal_entries (local_date) values ('2026-09-14') returning id`
      const [old] = await tx<{ id: string }[]>`
        insert into public.journal_recordings (entry_id, mime_type, status, uploaded_at, created_at, expires_at)
        values (${entry!.id}, 'audio/webm', 'failed', ${daysAgo(10)}, ${daysAgo(10)}, ${daysAgo(3)}) returning id`
      const [recent] = await tx<{ id: string }[]>`
        insert into public.journal_recordings (entry_id, mime_type, status, uploaded_at, created_at, expires_at)
        values (${entry!.id}, 'audio/webm', 'failed', ${daysAgo(1)}, ${daysAgo(1)}, ${new Date(daysAgo(1).getTime() + 7 * 86_400_000)})
        returning id`
      return [old!.id, recent!.id]
    })

    const result = await createRetentionPurgeJobHandler().run(context())
    expect(result).toMatchObject({
      journalRecordingsDeleted: 1,
      captureTextPurged: 2,
      captureTextRemaining: false,
    })

    const recordings = await withService(
      t.db,
      (tx) => tx<{ id: string }[]>`select id from public.journal_recordings`,
    )
    expect(recordings.map((r) => r.id)).toEqual([fresh])
    expect(recordings.map((r) => r.id)).not.toContain(expired)

    const texts = await withService(
      t.db,
      (tx) => tx<{ purged: boolean }[]>`
      select v.text is null as purged
      from public.captured_message_versions v join public.captured_messages m on m.id = v.message_id
      order by m.order_hint`,
    )
    expect(texts.map((r) => r.purged)).toEqual([true, true, false, false])

    // Idempotent: a second run finds nothing more to do.
    expect(await createRetentionPurgeJobHandler().run(context())).toMatchObject({
      journalRecordingsDeleted: 0,
      captureTextPurged: 0,
    })
  })
})
