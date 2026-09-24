/**
 * Journal entries and voice recordings against a real Postgres, as the owner through RLS.
 * Every recording test uses an explicit clock so expiry and staleness are deterministic.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JOURNAL_CHUNK_MIN_BYTES, JOURNAL_TRANSCRIPTION_STALE_MS } from '@personal-home/core'
import {
  beginJournalTranscription,
  completeJournalRecordingUpload,
  createJournalRecording,
  deleteJournalRecording,
  discardJournalTranscript,
  finishJournalTranscription,
  getJournalEntry,
  getJournalRecording,
  listJournalEntries,
  listJournalRecordings,
  purgeExpiredRecordings,
  putJournalRecordingChunk,
  readJournalRecordingAudio,
  saveJournalEntry,
  saveJournalTranscript,
  searchJournalEntries,
  withOwner,
  withService,
  type OwnerClaims,
  type Tx,
} from '../src/index.ts'
import { createAuthUser, createTestDatabase, seedOwner, withAnon, type TestDatabase } from './harness.ts'

let t: TestDatabase
let owner: OwnerClaims
let stranger: OwnerClaims

beforeAll(async () => {
  t = await createTestDatabase()
  owner = await seedOwner(t.db)
  stranger = await createAuthUser(t.db, 'stranger@example.com')
})
afterAll(async () => {
  await t?.drop()
})

const asOwner = <T>(fn: (tx: Tx) => Promise<T>) => withOwner(t.db, owner, fn)
const T0 = new Date('2026-09-24T09:00:00Z')
const at = (ms: number) => new Date(T0.getTime() + ms)
const DAY = 86_400_000
const CHUNK = JOURNAL_CHUNK_MIN_BYTES // small chunks keep test payloads small

let dateSeq = 0
/** A fresh local date per test so entries never collide. */
function freshDate(): string {
  dateSeq++
  const d = new Date(Date.UTC(2025, 0, 1) + dateSeq * DAY)
  return d.toISOString().slice(0, 10)
}

async function uploadedRecording(localDate: string, audio: Uint8Array, mimeType = 'audio/webm;codecs=opus') {
  const id = randomUUID()
  const created = await asOwner((tx) =>
    createJournalRecording(
      tx,
      { id, localDate, mimeType, byteSize: audio.byteLength, chunkBytes: CHUNK, durationSeconds: 4.5 },
      T0,
    ),
  )
  expect(created.status).toBe('created')
  for (let seq = 0; seq * CHUNK < audio.byteLength; seq++) {
    const data = audio.subarray(seq * CHUNK, Math.min(audio.byteLength, (seq + 1) * CHUNK))
    const r = await asOwner((tx) => putJournalRecordingChunk(tx, { recordingId: id, seq, data }, T0))
    expect(r.status).toBe('stored')
  }
  const done = await asOwner((tx) => completeJournalRecordingUpload(tx, id, T0))
  expect(done.status).toBe('uploaded')
  return id
}

describe('typed entries', () => {
  it('keeps one entry per local date and saves under optimistic concurrency', async () => {
    const d = freshDate()
    const created = await asOwner((tx) =>
      saveJournalEntry(tx, {
        localDate: d,
        baseVersion: 0,
        content: { body: 'Went for a run.', prompts: { moved_forward: 'Draft sent', what_happened: '  ' } },
      }),
    )
    expect(created.status).toBe('saved')
    if (created.status !== 'saved') return
    expect(created.entry).toMatchObject({ localDate: d, version: 1, origin: 'typed', prompts: { moved_forward: 'Draft sent' } })
    // Stored with the documented snake_case keys; blank answers are not stored at all.
    const [stored] = await t.db<{ prompts: string }[]>`select prompts::text as prompts from public.journal_entries where local_date = ${d}`
    expect(JSON.parse(stored!.prompts)).toEqual({ moved_forward: 'Draft sent' })

    // A second device that has not seen the entry yet does not create another one.
    const phone = await asOwner((tx) =>
      saveJournalEntry(tx, { localDate: d, baseVersion: 0, content: { body: 'From my phone', prompts: {} } }),
    )
    expect(phone.status).toBe('conflict')
    const [{ n }] = (await t.db`select count(*)::int as n from public.journal_entries where local_date = ${d}`) as unknown as [
      { n: number },
    ]
    expect(n).toBe(1)

    const updated = await asOwner((tx) =>
      saveJournalEntry(tx, { localDate: d, baseVersion: 1, content: { body: 'Went for a long run.', prompts: {} } }),
    )
    expect(updated.status === 'saved' && updated.entry.version).toBe(2)
    const stale = await asOwner((tx) =>
      saveJournalEntry(tx, { localDate: d, baseVersion: 1, content: { body: 'Stale edit', prompts: {} } }),
    )
    expect(stale.status).toBe('conflict')
    expect((await asOwner((tx) => getJournalEntry(tx, d)))?.body).toBe('Went for a long run.')
  })

  it('rejects mood or other unknown prompt fields', async () => {
    const r = await asOwner((tx) =>
      saveJournalEntry(tx, {
        localDate: freshDate(),
        baseVersion: 0,
        content: { body: '', prompts: { mood: 'great' } as never },
      }),
    )
    expect(r.status).toBe('invalid')
  })

  it('survives two devices creating the same day at the same moment', async () => {
    const d = freshDate()
    const results = await Promise.all(
      ['laptop', 'phone'].map((body) =>
        asOwner((tx) => saveJournalEntry(tx, { localDate: d, baseVersion: 0, content: { body, prompts: {} } })),
      ),
    )
    expect(results.map((r) => r.status).sort()).toEqual(['conflict', 'saved'])
  })

  it('lists entries newest first and searches them', async () => {
    const d = freshDate()
    await asOwner((tx) =>
      saveJournalEntry(tx, { localDate: d, baseVersion: 0, content: { body: 'Visited the aquarium today', prompts: {} } }),
    )
    const list = await asOwner((tx) => listJournalEntries(tx, { limit: 200 }))
    expect(list[0]!.localDate >= list[list.length - 1]!.localDate).toBe(true)
    expect(list.find((e) => e.localDate === d)?.preview).toBe('Visited the aquarium today')
    const hits = await asOwner((tx) => searchJournalEntries(tx, 'aquar'))
    expect(hits.map((h) => h.localDate)).toContain(d)
    expect(hits[0]!.snippet).toContain('aquarium')
  })
})

describe('recording upload (chunked, resumable, idempotent)', () => {
  it('registers a recording idempotently and creates the day as a voice entry', async () => {
    const d = freshDate()
    const id = randomUUID()
    const input = { id, localDate: d, mimeType: 'audio/webm;codecs=opus', byteSize: 10, chunkBytes: CHUNK, durationSeconds: 1 }
    const first = await asOwner((tx) => createJournalRecording(tx, input, T0))
    expect(first.status).toBe('created')
    if (first.status !== 'created') return
    expect(first.recording).toMatchObject({ status: 'uploading', expectedChunks: 1, receivedChunks: [] })
    expect(first.recording.expiresAt).toBe(at(7 * DAY).toISOString())
    expect((await asOwner((tx) => getJournalEntry(tx, d)))).toMatchObject({ origin: 'voice', transcriptStatus: 'pending' })

    expect((await asOwner((tx) => createJournalRecording(tx, input, T0))).status).toBe('exists')
    expect(await asOwner((tx) => createJournalRecording(tx, { ...input, byteSize: 11 }, T0))).toEqual({
      status: 'id_conflict',
    })
    expect((await asOwner((tx) => createJournalRecording(tx, { ...input, id: randomUUID(), mimeType: 'text/html' }, T0))).status).toBe(
      'invalid',
    )
  })

  it('accepts repeated identical chunks, refuses different bytes, bad sizes and bad sequence numbers', async () => {
    const audio = randomBytes(CHUNK * 2 + 100)
    const id = randomUUID()
    await asOwner((tx) =>
      createJournalRecording(
        tx,
        { id, localDate: freshDate(), mimeType: 'audio/mp4', byteSize: audio.byteLength, chunkBytes: CHUNK, durationSeconds: 3 },
        T0,
      ),
    )
    const put = (seq: number, data: Uint8Array) =>
      asOwner((tx) => putJournalRecordingChunk(tx, { recordingId: id, seq, data }, T0))

    expect(await put(1, audio.subarray(CHUNK, 2 * CHUNK))).toEqual({ status: 'stored', received: 1, expected: 3 })
    expect(await put(1, audio.subarray(CHUNK, 2 * CHUNK))).toEqual({ status: 'duplicate', received: 1, expected: 3 })
    expect(await put(1, randomBytes(CHUNK))).toEqual({ status: 'mismatch' })
    expect(await put(0, audio.subarray(0, CHUNK - 1))).toEqual({ status: 'invalid_size', expectedSize: CHUNK })
    expect(await put(2, audio.subarray(0, 50))).toEqual({ status: 'invalid_size', expectedSize: 100 })
    expect(await put(3, audio.subarray(0, 100))).toEqual({ status: 'invalid_seq', expectedSize: null })
    expect(await asOwner((tx) => putJournalRecordingChunk(tx, { recordingId: randomUUID(), seq: 0, data: audio.subarray(0, 1) }, T0))).toEqual({
      status: 'not_found',
    })

    // Completing early reports exactly what is missing (resume point).
    const early = await asOwner((tx) => completeJournalRecordingUpload(tx, id, T0))
    expect(early.status === 'incomplete' && early.missing).toEqual([0, 2])

    expect((await put(2, audio.subarray(2 * CHUNK))).status).toBe('stored')
    expect((await put(0, audio.subarray(0, CHUNK))).status).toBe('stored')
    expect((await asOwner((tx) => completeJournalRecordingUpload(tx, id, T0))).status).toBe('uploaded')
    expect((await asOwner((tx) => completeJournalRecordingUpload(tx, id, T0))).status).toBe('already')

    // After completion only identical repeats are accepted.
    expect((await put(0, audio.subarray(0, CHUNK))).status).toBe('duplicate')
    expect(await put(0, randomBytes(CHUNK))).toEqual({ status: 'not_uploading' })

    // Assembly returns the exact original bytes, in order.
    const read = await asOwner((tx) => readJournalRecordingAudio(tx, id, T0))
    expect(Buffer.from(read!.audio).equals(audio)).toBe(true)
    expect(read!.recording.mimeType).toBe('audio/mp4')
  })

  it('refuses to download or transcribe an upload that is not complete', async () => {
    const id = randomUUID()
    await asOwner((tx) =>
      createJournalRecording(
        tx,
        { id, localDate: freshDate(), mimeType: 'audio/webm', byteSize: CHUNK + 1, chunkBytes: CHUNK, durationSeconds: 1 },
        T0,
      ),
    )
    expect(await asOwner((tx) => readJournalRecordingAudio(tx, id, T0))).toBeNull()
    const begin = await asOwner((tx) => beginJournalTranscription(tx, id, T0))
    expect(begin.status === 'incomplete' && begin.missing).toEqual([0, 1])
  })
})

describe('transcription attempts', () => {
  it('puts a transcript into the review draft (not the entry text) and keeps the recording', async () => {
    const d = freshDate()
    await asOwner((tx) =>
      saveJournalEntry(tx, { localDate: d, baseVersion: 0, content: { body: 'Typed first.', prompts: {} } }),
    )
    const audio = randomBytes(CHUNK + 10)
    const id = await uploadedRecording(d, audio)

    const begin = await asOwner((tx) => beginJournalTranscription(tx, id, at(1000)))
    expect(begin.status).toBe('claimed')
    if (begin.status !== 'claimed') return
    expect(begin.attempt).toBe(1)
    expect(Buffer.from(begin.audio).equals(audio)).toBe(true)
    expect((await asOwner((tx) => getJournalEntry(tx, d)))?.transcriptStatus).toBe('transcribing')

    // A second attempt while the first runs is refused.
    expect((await asOwner((tx) => beginJournalTranscription(tx, id, at(2000)))).status).toBe('in_progress')

    const done = await asOwner((tx) =>
      finishJournalTranscription(tx, { id, attempt: 1, outcome: { kind: 'transcript', text: 'Spoken words.' } }, at(3000)),
    )
    expect(done.status).toBe('transcribed')
    const entry = await asOwner((tx) => getJournalEntry(tx, d))
    expect(entry).toMatchObject({ body: 'Typed first.', transcriptDraft: 'Spoken words.', transcriptStatus: 'ready_for_review', version: 1 })
    expect((await asOwner((tx) => getJournalRecording(tx, id, at(3000))))?.status).toBe('transcribed')
    expect((await asOwner((tx) => beginJournalTranscription(tx, id, at(4000)))).status).toBe('not_retryable')
  })

  it('treats an empty transcript as a failure and never writes it', async () => {
    const d = freshDate()
    const id = await uploadedRecording(d, randomBytes(500))
    await asOwner((tx) => beginJournalTranscription(tx, id, T0))
    const r = await asOwner((tx) =>
      finishJournalTranscription(tx, { id, attempt: 1, outcome: { kind: 'transcript', text: '  \n ' } }, T0),
    )
    expect(r.status === 'failed' && r.reason).toBe('empty_transcript')
    expect((await asOwner((tx) => getJournalEntry(tx, d)))).toMatchObject({ transcriptDraft: null, transcriptStatus: 'failed' })
  })

  it('records "not configured" as unavailable, keeps the recording and lets it be retried', async () => {
    const d = freshDate()
    const id = await uploadedRecording(d, randomBytes(700))
    await asOwner((tx) => beginJournalTranscription(tx, id, T0))
    const failed = await asOwner((tx) =>
      finishJournalTranscription(tx, { id, attempt: 1, outcome: { kind: 'failure', reason: 'not_configured' } }, T0),
    )
    expect(failed.status).toBe('failed')
    const rec = await asOwner((tx) => getJournalRecording(tx, id, T0))
    expect(rec).toMatchObject({ status: 'failed', failureReason: 'not_configured', attempts: 1, receivedChunks: [0] })
    expect(rec!.expiresAt).toBe(at(7 * DAY).toISOString())
    expect((await asOwner((tx) => getJournalEntry(tx, d)))?.transcriptStatus).toBe('unavailable')

    const retry = await asOwner((tx) => beginJournalTranscription(tx, id, at(DAY)))
    expect(retry.status === 'claimed' && retry.attempt).toBe(2)
    // Retrying never extends retention.
    expect((await asOwner((tx) => getJournalRecording(tx, id, at(DAY))))?.expiresAt).toBe(at(7 * DAY).toISOString())
  })

  it('fences attempts: a stale attempt can be taken over and its late result is discarded', async () => {
    const d = freshDate()
    const id = await uploadedRecording(d, randomBytes(300))
    const first = await asOwner((tx) => beginJournalTranscription(tx, id, T0))
    expect(first.status).toBe('claimed')
    const takeover = await asOwner((tx) => beginJournalTranscription(tx, id, at(JOURNAL_TRANSCRIPTION_STALE_MS)))
    expect(takeover.status === 'claimed' && takeover.attempt).toBe(2)

    const late = await asOwner((tx) =>
      finishJournalTranscription(tx, { id, attempt: 1, outcome: { kind: 'transcript', text: 'late' } }, at(JOURNAL_TRANSCRIPTION_STALE_MS + 1)),
    )
    expect(late.status).toBe('superseded')
    expect((await asOwner((tx) => getJournalEntry(tx, d)))?.transcriptDraft).toBeNull()
  })

  it('reports a recording deleted mid-attempt instead of resurrecting it', async () => {
    const id = await uploadedRecording(freshDate(), randomBytes(300))
    await asOwner((tx) => beginJournalTranscription(tx, id, T0))
    expect(await asOwner((tx) => deleteJournalRecording(tx, id))).toBe(true)
    expect(
      await asOwner((tx) => finishJournalTranscription(tx, { id, attempt: 1, outcome: { kind: 'transcript', text: 'x' } }, T0)),
    ).toEqual({ status: 'deleted' })
  })
})

describe('reviewing the transcript', () => {
  async function transcribed(d: string, text: string) {
    const id = await uploadedRecording(d, randomBytes(400))
    const b = await asOwner((tx) => beginJournalTranscription(tx, id, T0))
    if (b.status !== 'claimed') throw new Error('not claimed')
    await asOwner((tx) => finishJournalTranscription(tx, { id, attempt: b.attempt, outcome: { kind: 'transcript', text } }, T0))
    return id
  }

  it('adds the edited transcript to the entry and deletes the recordings only then', async () => {
    const d = freshDate()
    const saved = await asOwner((tx) =>
      saveJournalEntry(tx, { localDate: d, baseVersion: 0, content: { body: 'Typed.', prompts: {} } }),
    )
    const v = saved.status === 'saved' ? saved.entry.version : 0
    const rec1 = await transcribed(d, 'first recording')
    const rec2 = await transcribed(d, 'second recording')
    const failedRec = await uploadedRecording(d, randomBytes(200))
    await asOwner((tx) => beginJournalTranscription(tx, failedRec, T0))
    await asOwner((tx) =>
      finishJournalTranscription(tx, { id: failedRec, attempt: 1, outcome: { kind: 'failure', reason: 'budget_exhausted' } }, T0),
    )

    const entry = await asOwner((tx) => getJournalEntry(tx, d))
    expect(entry?.transcriptDraft).toBe('first recording\n\nsecond recording')

    // The device showed an older draft: nothing is cleared unseen.
    const stale = await asOwner((tx) =>
      saveJournalTranscript(tx, { localDate: d, baseVersion: v, draftSeen: 'first recording', text: 'x' }),
    )
    expect(stale.status).toBe('draft_changed')
    // The typed text moved on: flush first.
    const conflict = await asOwner((tx) =>
      saveJournalTranscript(tx, { localDate: d, baseVersion: v + 5, draftSeen: entry!.transcriptDraft!, text: 'x' }),
    )
    expect(conflict.status).toBe('conflict')
    expect((await asOwner((tx) => saveJournalTranscript(tx, { localDate: d, baseVersion: v, draftSeen: entry!.transcriptDraft!, text: '  ' }))).status).toBe(
      'invalid',
    )
    expect(await asOwner((tx) => listJournalRecordings(tx, { localDate: d, now: T0 }))).toHaveLength(3)

    const ok = await asOwner((tx) =>
      saveJournalTranscript(tx, {
        localDate: d,
        baseVersion: v,
        draftSeen: entry!.transcriptDraft!,
        text: 'First recording, edited. Second recording.',
      }),
    )
    expect(ok.status).toBe('saved')
    if (ok.status !== 'saved') return
    expect(ok.recordingsDeleted).toBe(2)
    expect(ok.entry).toMatchObject({
      body: 'Typed.\n\nFirst recording, edited. Second recording.',
      transcriptDraft: null,
      version: v + 1,
      // The failed recording is still there for retry.
      transcriptStatus: 'failed',
    })
    const left = await asOwner((tx) => listJournalRecordings(tx, { localDate: d, now: T0 }))
    expect(left.map((r) => r.id)).toEqual([failedRec])
    const chunks = await t.db`select 1 from public.journal_recording_chunks where recording_id in (${rec1}, ${rec2})`
    expect(chunks).toHaveLength(0)
  })

  it('discarding keeps the recordings (as failed, retryable) and clears only the draft', async () => {
    const d = freshDate()
    const id = await transcribed(d, 'not what I said')
    const entry = await asOwner((tx) => getJournalEntry(tx, d))
    expect((await asOwner((tx) => discardJournalTranscript(tx, { localDate: d, draftSeen: 'other' }))).status).toBe(
      'draft_changed',
    )
    const r = await asOwner((tx) => discardJournalTranscript(tx, { localDate: d, draftSeen: entry!.transcriptDraft! }))
    expect(r.status).toBe('discarded')
    expect(await asOwner((tx) => getJournalRecording(tx, id, T0))).toMatchObject({
      status: 'failed',
      failureReason: 'transcript_discarded',
    })
    expect((await asOwner((tx) => beginJournalTranscription(tx, id, T0))).status).toBe('claimed')
  })
})

describe('retention', () => {
  it('purges recordings exactly at their expiry, cascades chunks and keeps drafts and text', async () => {
    const d = freshDate()
    await asOwner((tx) =>
      saveJournalEntry(tx, { localDate: d, baseVersion: 0, content: { body: 'Keep me', prompts: {} } }),
    )
    const id = await uploadedRecording(d, randomBytes(300))
    const b = await asOwner((tx) => beginJournalTranscription(tx, id, T0))
    if (b.status !== 'claimed') throw new Error('not claimed')
    await asOwner((tx) =>
      finishJournalTranscription(tx, { id, attempt: 1, outcome: { kind: 'transcript', text: 'unreviewed transcript' } }, T0),
    )

    // Invisible to the owner once expired, even before the purge runs.
    expect(await asOwner((tx) => getJournalRecording(tx, id, at(7 * DAY)))).toBeNull()
    expect(await asOwner((tx) => putJournalRecordingChunk(tx, { recordingId: id, seq: 0, data: randomBytes(300) }, at(7 * DAY)))).toEqual({
      status: 'not_found',
    })

    const early = await withService(t.db, (tx) => purgeExpiredRecordings(tx, at(7 * DAY - 1)))
    expect((await t.db`select 1 from public.journal_recordings where id = ${id}`).length).toBe(1)
    expect(early.deleted).toBeGreaterThanOrEqual(0)

    const purged = await withService(t.db, (tx) => purgeExpiredRecordings(tx, at(7 * DAY)))
    expect(purged.deleted).toBeGreaterThanOrEqual(1)
    expect((await t.db`select 1 from public.journal_recordings where id = ${id}`).length).toBe(0)
    expect((await t.db`select 1 from public.journal_recording_chunks where recording_id = ${id}`).length).toBe(0)
    expect(await asOwner((tx) => getJournalEntry(tx, d))).toMatchObject({
      body: 'Keep me',
      transcriptDraft: 'unreviewed transcript',
      transcriptStatus: 'ready_for_review',
    })
  })

  it('runs under the owner too (RLS allows the delete) and the database caps retention at seven days', async () => {
    const id = await uploadedRecording(freshDate(), randomBytes(100))
    const r = await asOwner((tx) => purgeExpiredRecordings(tx, at(8 * DAY)))
    expect(r.deleted).toBeGreaterThanOrEqual(1)
    expect((await t.db`select 1 from public.journal_recordings where id = ${id}`).length).toBe(0)

    const other = await uploadedRecording(freshDate(), randomBytes(100))
    await expect(
      t.db`update public.journal_recordings set expires_at = expires_at + interval '1 day' where id = ${other}`,
    ).rejects.toThrow(/journal_recordings_expiry_within_retention/)
  })
})

describe('row level security', () => {
  it('keeps entries, recordings and audio chunks away from anon and non-owners', async () => {
    const d = freshDate()
    const id = await uploadedRecording(d, randomBytes(100))
    for (const table of ['journal_entries', 'journal_recordings', 'journal_recording_chunks']) {
      await expect(withAnon(t.db, (tx) => tx.unsafe(`select * from public.${table}`))).rejects.toThrow(/permission denied/)
      const rows = await withOwner(t.db, stranger, (tx) => tx.unsafe(`select * from public.${table}`))
      expect(rows).toHaveLength(0)
    }
    expect(await withOwner(t.db, stranger, (tx) => readJournalRecordingAudio(tx, id, T0))).toBeNull()
    expect(await withOwner(t.db, stranger, (tx) => deleteJournalRecording(tx, id))).toBe(false)
    await expect(
      withOwner(t.db, stranger, (tx) =>
        createJournalRecording(
          tx,
          { id: randomUUID(), localDate: freshDate(), mimeType: 'audio/webm', byteSize: 1, chunkBytes: CHUNK, durationSeconds: 1 },
          T0,
        ),
      ),
    ).rejects.toThrow(/row-level security/)
    expect(await asOwner((tx) => getJournalRecording(tx, id, T0))).not.toBeNull()
  })
})
