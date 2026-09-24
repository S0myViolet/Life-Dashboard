/**
 * Journal transcription orchestration and recording retention against a real Postgres.
 * Transcribers here are fakes: the AI gateway is wired in by the integrator (see
 * journal-gateway.test.ts for the path through the real gateway with a fake fetch).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { JOURNAL_CHUNK_MIN_BYTES, JOURNAL_TRANSCRIPTION_STALE_MS } from '@personal-home/core'
import {
  completeJournalRecordingUpload,
  createJournalRecording,
  deleteJournalRecording,
  enqueueJob,
  getJob,
  getJournalEntry,
  getJournalRecording,
  putJournalRecordingChunk,
  withOwner,
  withService,
  type OwnerClaims,
  type Tx,
} from '@personal-home/db'
import { createTestDatabase, seedOwner, type TestDatabase } from '@personal-home/db/testing'
import {
  createGatewayJournalTranscriber,
  createJobHandlerRegistry,
  createJournalRetentionPurgeJobHandler,
  journalFailureReasonFromGatewayCode,
  notConfiguredJournalTranscriber,
  runDispatcher,
  runJournalRecordingRetention,
  transcribeJournalRecording,
  type JournalGatewayTranscriptionResult,
  type JournalTranscriber,
  type JournalTxRunner,
} from '../src/index.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    templateDb: string
  }
}

let t: TestDatabase
let owner: OwnerClaims
beforeAll(async () => {
  t = await createTestDatabase()
  owner = await seedOwner(t.db)
})
afterAll(async () => {
  await t?.drop()
})

const T0 = new Date('2026-09-24T09:00:00Z')
const DAY = 86_400_000
const CHUNK = JOURNAL_CHUNK_MIN_BYTES
const ownerRun: JournalTxRunner = (fn) => withOwner(t.db, owner, fn)
const serviceRun: JournalTxRunner = (fn) => withService(t.db, fn)
const asOwner = <T>(fn: (tx: Tx) => Promise<T>) => withOwner(t.db, owner, fn)

let dateSeq = 0
const freshDate = () => new Date(Date.UTC(2024, 0, 1) + ++dateSeq * DAY).toISOString().slice(0, 10)

async function uploaded(audio: Uint8Array, mimeType = 'audio/webm;codecs=opus', localDate = freshDate()) {
  const id = randomUUID()
  await asOwner((tx) =>
    createJournalRecording(
      tx,
      { id, localDate, mimeType, byteSize: audio.byteLength, chunkBytes: CHUNK, durationSeconds: 12.5 },
      T0,
    ),
  )
  for (let seq = 0; seq * CHUNK < audio.byteLength; seq++) {
    await asOwner((tx) =>
      putJournalRecordingChunk(tx, { recordingId: id, seq, data: audio.subarray(seq * CHUNK, (seq + 1) * CHUNK) }, T0),
    )
  }
  await asOwner((tx) => completeJournalRecordingUpload(tx, id, T0))
  return { id, localDate }
}

const fixed = (text: string): JournalTranscriber => vi.fn(async () => ({ status: 'ok' as const, text }))

describe('transcribeJournalRecording', () => {
  it('sends the exact audio and lands the transcript as a reviewable draft (owner transaction)', async () => {
    const audio = randomBytes(CHUNK * 2 + 17)
    const { id, localDate } = await uploaded(audio)
    const transcriber = vi.fn<JournalTranscriber>(async () => ({ status: 'ok', text: 'I walked to the river.' }))
    const r = await transcribeJournalRecording({ run: ownerRun, transcriber, now: () => T0 }, id)
    expect(r.status).toBe('transcribed')
    expect(transcriber).toHaveBeenCalledTimes(1)
    const [sent] = transcriber.mock.calls[0]!
    expect(Buffer.from(sent.bytes).equals(audio)).toBe(true)
    expect(sent).toMatchObject({ mimeType: 'audio/webm;codecs=opus', durationSeconds: 12.5 })

    const entry = await asOwner((tx) => getJournalEntry(tx, localDate))
    // Editable draft, not saved into the entry text.
    expect(entry).toMatchObject({ body: '', transcriptDraft: 'I walked to the river.', transcriptStatus: 'ready_for_review' })
    // The recording stays until the owner saves the transcript.
    expect((await asOwner((tx) => getJournalRecording(tx, id, T0)))?.status).toBe('transcribed')
  })

  it('without AI configured: fails honestly, keeps the recording with its expiry, and can be retried later', async () => {
    const { id, localDate } = await uploaded(randomBytes(900))
    const r = await transcribeJournalRecording({ run: ownerRun, transcriber: notConfiguredJournalTranscriber, now: () => T0 }, id)
    expect(r.status === 'failed' && r.reason).toBe('not_configured')
    const rec = await asOwner((tx) => getJournalRecording(tx, id, T0))
    expect(rec).toMatchObject({ status: 'failed', failureReason: 'not_configured', receivedChunks: [0] })
    expect(rec!.expiresAt).toBe(new Date(T0.getTime() + 7 * DAY).toISOString())
    expect((await asOwner((tx) => getJournalEntry(tx, localDate)))?.transcriptDraft).toBeNull()

    const retry = await transcribeJournalRecording(
      { run: serviceRun, transcriber: fixed('Retried later.'), now: () => new Date(T0.getTime() + DAY) },
      id,
    )
    expect(retry.status).toBe('transcribed')
    if (retry.status === 'transcribed') expect(retry.recording.attempts).toBe(2)
  })

  it('maps budget exhaustion, empty transcripts, thrown errors and hangs to kept, failed recordings', async () => {
    const cases: Array<[JournalTranscriber, string, number?]> = [
      [async () => ({ status: 'budget_exhausted', reason: 'budget_exhausted' }), 'budget_exhausted'],
      [async () => ({ status: 'ok', text: '   ' }), 'empty_transcript'],
      [async () => ({ status: 'failed', reason: 'provider_rejected' }), 'provider_rejected'],
      [async () => ({ status: 'failed', reason: 'weird provider text <script>' }), 'provider_error'],
      [
        async () => {
          throw new Error('provider said: secret journal words')
        },
        'provider_error',
      ],
      [() => new Promise(() => {}), 'interrupted', 30],
    ]
    for (const [transcriber, reason, timeoutMs] of cases) {
      const { id } = await uploaded(randomBytes(200))
      const r = await transcribeJournalRecording({ run: ownerRun, transcriber, now: () => T0, timeoutMs }, id)
      expect(r.status === 'failed' && r.reason).toBe(reason)
      const [row] = await t.db<{ failureReason: string }[]>`
        select failure_reason from public.journal_recordings where id = ${id}
      `
      expect(row?.failureReason).toBe(reason)
    }
  })

  it('does not transcribe twice when two requests race (one attempt holds the recording)', async () => {
    const { id, localDate } = await uploaded(randomBytes(300))
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const transcriber = vi.fn<JournalTranscriber>(async () => {
      await gate
      return { status: 'ok', text: 'once' }
    })
    const first = transcribeJournalRecording({ run: ownerRun, transcriber, now: () => T0 }, id)
    await vi.waitFor(() => expect(transcriber).toHaveBeenCalledTimes(1))
    const second = await transcribeJournalRecording({ run: ownerRun, transcriber, now: () => T0 }, id)
    expect(second.status).toBe('in_progress')
    release()
    expect((await first).status).toBe('transcribed')
    expect(transcriber).toHaveBeenCalledTimes(1)
    expect((await asOwner((tx) => getJournalEntry(tx, localDate)))?.transcriptDraft).toBe('once')
  })

  it('lets a retry take over an interrupted attempt and ignores the stale result', async () => {
    const { id, localDate } = await uploaded(randomBytes(300))
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow = vi.fn<JournalTranscriber>(async () => {
      await gate
      return { status: 'ok', text: 'stale words' }
    })
    const first = transcribeJournalRecording({ run: ownerRun, transcriber: slow, now: () => T0 }, id)
    await vi.waitFor(() => expect(slow).toHaveBeenCalled())
    const later = new Date(T0.getTime() + JOURNAL_TRANSCRIPTION_STALE_MS)
    const takeover = await transcribeJournalRecording({ run: ownerRun, transcriber: fixed('fresh words'), now: () => later }, id)
    expect(takeover.status).toBe('transcribed')
    release()
    // The late result is not stored; the caller sees the recording's current state.
    const late = await first
    expect(late.status).toBe('transcribed')
    expect((await asOwner((tx) => getJournalEntry(tx, localDate)))?.transcriptDraft).toBe('fresh words')
  })

  it('does not call the transcriber for an incomplete upload, and reports a recording deleted mid-call', async () => {
    const id = randomUUID()
    await asOwner((tx) =>
      createJournalRecording(
        tx,
        { id, localDate: freshDate(), mimeType: 'audio/webm', byteSize: 10, chunkBytes: CHUNK, durationSeconds: 1 },
        T0,
      ),
    )
    const never = vi.fn<JournalTranscriber>()
    const r = await transcribeJournalRecording({ run: ownerRun, transcriber: never, now: () => T0 }, id)
    expect(r.status === 'incomplete' && r.missing).toEqual([0])
    expect(never).not.toHaveBeenCalled()
    expect((await transcribeJournalRecording({ run: ownerRun, transcriber: never, now: () => T0 }, randomUUID())).status).toBe(
      'not_found',
    )

    const { id: doomed } = await uploaded(randomBytes(100))
    const deleting: JournalTranscriber = async () => {
      await asOwner((tx) => deleteJournalRecording(tx, doomed))
      return { status: 'ok', text: 'too late' }
    }
    expect(await transcribeJournalRecording({ run: ownerRun, transcriber: deleting, now: () => T0 }, doomed)).toEqual({
      status: 'deleted',
    })
  })
})

describe('gateway adapter (structural, mirrors runAiTranscription results)', () => {
  const audio = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/mp4', durationSeconds: 3 }
  const signal = new AbortController().signal
  const via = (result: JournalGatewayTranscriptionResult | Error) =>
    createGatewayJournalTranscriber(async () => {
      if (result instanceof Error) throw result
      return result
    })(audio, signal)

  it('maps every gateway status to an honest journal outcome', async () => {
    expect(await via({ status: 'ok', transcript: 'hello', empty: false })).toEqual({ status: 'ok', text: 'hello' })
    expect(await via({ status: 'ok', transcript: '', empty: true })).toEqual({ status: 'failed', reason: 'empty_transcript' })
    expect(await via({ status: 'budget_exhausted' })).toEqual({ status: 'budget_exhausted', reason: 'budget_exhausted' })
    expect(await via({ status: 'disabled', reason: 'no_api_key' })).toEqual({ status: 'not_configured', reason: 'no_api_key' })
    // iPhone audio/mp4 refused by the provider: failed, never a fake transcript.
    expect(await via({ status: 'failed', outcome: 'ambiguous', code: 'http_400' })).toEqual({
      status: 'failed',
      reason: 'provider_rejected',
    })
    expect(await via({ status: 'failed', outcome: 'ambiguous', code: 'http_503' })).toEqual({
      status: 'failed',
      reason: 'provider_error',
    })
    expect(await via(new Error('unexpected'))).toEqual({ status: 'failed', reason: 'provider_error' })
  })

  it('passes audio, type and duration through, and does not call the gateway once aborted', async () => {
    const run = vi.fn(async () => ({ status: 'ok' as const, transcript: 'x', empty: false }))
    await createGatewayJournalTranscriber(run)(audio, signal)
    expect(run).toHaveBeenCalledWith({ audio: audio.bytes, mimeType: 'audio/mp4', audioSeconds: 3 })
    const aborted = new AbortController()
    aborted.abort()
    expect(await createGatewayJournalTranscriber(run)(audio, aborted.signal)).toEqual({
      status: 'failed',
      reason: 'interrupted',
    })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('classifies gateway and HTTP codes', () => {
    expect(journalFailureReasonFromGatewayCode('audio_too_large')).toBe('audio_too_large')
    expect(journalFailureReasonFromGatewayCode('unsupported_audio_type')).toBe('unsupported_format')
    expect(journalFailureReasonFromGatewayCode('missing_api_key')).toBe('not_configured')
    expect(journalFailureReasonFromGatewayCode('http_415')).toBe('provider_rejected')
    expect(journalFailureReasonFromGatewayCode('http_429')).toBe('provider_error')
    expect(journalFailureReasonFromGatewayCode('http_408')).toBe('provider_error')
    expect(journalFailureReasonFromGatewayCode('timeout')).toBe('provider_error')
    expect(journalFailureReasonFromGatewayCode('ledger_unavailable')).toBe('provider_error')
  })
})

describe('recording retention', () => {
  it('purges only expired recordings', async () => {
    const { id } = await uploaded(randomBytes(100))
    const before = await runJournalRecordingRetention({ db: t.db, now: () => new Date(T0.getTime() + 7 * DAY - 1) })
    expect((await t.db`select 1 from public.journal_recordings where id = ${id}`).length).toBe(1)
    expect(before.journalRecordingsDeleted).toBe(0)
    const after = await runJournalRecordingRetention({ db: t.db, now: () => new Date(T0.getTime() + 7 * DAY) })
    expect(after.journalRecordingsDeleted).toBeGreaterThanOrEqual(1)
    expect((await t.db`select 1 from public.journal_recordings where id = ${id}`).length).toBe(0)
  })

  it('runs as a retention.purge job through the dispatcher', async () => {
    const { id } = await uploaded(randomBytes(100))
    const now = new Date(T0.getTime() + 30 * DAY)
    const { job } = await withService(t.db, (tx) =>
      enqueueJob(tx, { kind: 'retention.purge', dedupeKey: `retention.purge:test-${randomUUID()}`, payload: {} }, now),
    )
    const summary = await runDispatcher({
      db: t.db,
      workerId: 'test-worker',
      handlers: createJobHandlerRegistry([createJournalRetentionPurgeJobHandler()]),
      budgetMs: 20_000,
      maxJobs: 5,
      now: () => now,
      schedules: [],
    })
    expect(summary.totals.succeeded).toBeGreaterThanOrEqual(1)
    const done = await withService(t.db, (tx) => getJob(tx, job.id))
    expect(done?.status).toBe('succeeded')
    expect((done?.result as { journalRecordingsDeleted: number }).journalRecordingsDeleted).toBeGreaterThanOrEqual(1)
    expect((await t.db`select 1 from public.journal_recordings where id = ${id}`).length).toBe(0)
  })
})
