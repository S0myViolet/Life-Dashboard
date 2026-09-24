/**
 * Journal transcription through the real AI gateway (budget ledger + Gemini client) with a fake
 * fetch. The gateway lives on branch m0/ai and is not in this area's base: these tests are skipped
 * until it is merged (packages/jobs/src/ai/gateway.ts exists), then run unchanged.
 *
 * Every Gemini response below is a SYNTHETIC FIXTURE (not captured from the live service), shaped
 * from docs/research/gemini.md: the transcript arrives in parts[].audioTranscription.text.
 */
import { existsSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { JOURNAL_CHUNK_MIN_BYTES } from '@personal-home/core'
import * as db from '@personal-home/db'
import { createTestDatabase, seedOwner, type TestDatabase } from '@personal-home/db/testing'
import {
  createGatewayJournalTranscriber,
  transcribeJournalRecording,
  type JournalGatewayTranscriptionRequest,
  type JournalGatewayTranscriptionResult,
  type JournalTxRunner,
} from '../src/index.ts'

declare module 'vitest' {
  export interface ProvidedContext {
    templateDb: string
  }
}

const GATEWAY = new URL('../src/ai/gateway.ts', import.meta.url)
const hasGateway = existsSync(GATEWAY)

type RunAiTranscription = (input: Record<string, unknown>) => Promise<JournalGatewayTranscriptionResult>
type Settings = Record<string, unknown>
const dbAny = db as unknown as {
  getAiBudgetSettings?: (tx: db.Tx) => Promise<Settings>
  updateAiBudgetSettings?: (tx: db.Tx, patch: Settings) => Promise<Settings>
}

const T0 = new Date('2026-09-24T09:00:00Z')
const CHUNK = JOURNAL_CHUNK_MIN_BYTES
let t: TestDatabase
let owner: db.OwnerClaims
let runAiTranscription: RunAiTranscription
let defaults: Settings
let dateSeq = 0

describe.skipIf(!hasGateway)('journal transcription through the AI gateway (fake fetch)', () => {
  beforeAll(async () => {
    t = await createTestDatabase()
    owner = await seedOwner(t.db)
    const spec = GATEWAY.href
    runAiTranscription = ((await import(/* @vite-ignore */ spec)) as { runAiTranscription: RunAiTranscription })
      .runAiTranscription
    defaults = await db.withService(t.db, (tx) => dbAny.getAiBudgetSettings!(tx))
  })
  afterAll(async () => {
    await t?.drop()
  })

  const ownerRun: JournalTxRunner = (fn) => db.withOwner(t.db, owner, fn)

  async function uploaded(mimeType: string) {
    const audio = randomBytes(CHUNK + 50)
    const id = randomUUID()
    const localDate = new Date(Date.UTC(2023, 0, 1) + ++dateSeq * 86_400_000).toISOString().slice(0, 10)
    await ownerRun((tx) =>
      db.createJournalRecording(tx, { id, localDate, mimeType, byteSize: audio.byteLength, chunkBytes: CHUNK, durationSeconds: 20 }, T0),
    )
    for (let seq = 0; seq < 2; seq++) {
      await ownerRun((tx) =>
        db.putJournalRecordingChunk(tx, { recordingId: id, seq, data: audio.subarray(seq * CHUNK, (seq + 1) * CHUNK) }, T0),
      )
    }
    await ownerRun((tx) => db.completeJournalRecordingUpload(tx, id, T0))
    return { id, localDate }
  }

  function transcriberWith(fetch: (url: string, init: RequestInit) => Promise<Response>, apiKey: string | null = 'test-key-not-real') {
    return createGatewayJournalTranscriber((req: JournalGatewayTranscriptionRequest) =>
      runAiTranscription({ db: t.db, fetch, now: () => T0, timezone: 'Europe/London', apiKey, ...req }),
    )
  }

  // SYNTHETIC FIXTURE (not captured from the live service)
  const transcriptResponse = (text: string) =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ audioTranscription: { text, finished: true } }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 640,
          candidatesTokenCount: 12,
          totalTokenCount: 652,
          promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 640 }],
        },
        modelVersion: 'gemini-3.5-transcribe',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  it('success: WebM is sent as audio/webm and the transcript becomes a review draft', async () => {
    const { id, localDate } = await uploaded('audio/webm;codecs=opus')
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => transcriptResponse('Synthetic transcript text.'))
    const r = await transcribeJournalRecording({ run: ownerRun, transcriber: transcriberWith(fetch), now: () => T0 }, id)
    expect(r.status).toBe('transcribed')
    expect(fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(fetch.mock.calls[0]![1].body))
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe('audio/webm')
    expect((await ownerRun((tx) => db.getJournalEntry(tx, localDate)))?.transcriptDraft).toBe('Synthetic transcript text.')
  })

  it('iPhone audio/mp4 rejected by the provider: failed and kept, no transcript invented', async () => {
    const { id, localDate } = await uploaded('audio/mp4')
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT' } }), { status: 400 }),
    )
    const r = await transcribeJournalRecording({ run: ownerRun, transcriber: transcriberWith(fetch), now: () => T0 }, id)
    expect(r.status === 'failed' && r.reason).toBe('provider_rejected')
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body)).contents[0].parts[0].inlineData.mimeType).toBe('audio/m4a')
    expect((await ownerRun((tx) => db.getJournalEntry(tx, localDate)))?.transcriptDraft).toBeNull()
    expect((await ownerRun((tx) => db.getJournalRecording(tx, id, T0)))?.status).toBe('failed')
  })

  it('empty transcript (HTTP 200, no text) is a failure', async () => {
    const { id } = await uploaded('audio/webm')
    const r = await transcribeJournalRecording(
      { run: ownerRun, transcriber: transcriberWith(async () => transcriptResponse('')), now: () => T0 },
      id,
    )
    expect(r.status === 'failed' && r.reason).toBe('empty_transcript')
  })

  it('budget exhausted: nothing is sent and the recording is kept', async () => {
    const { id } = await uploaded('audio/webm')
    const fetch = vi.fn(async () => transcriptResponse('should not happen'))
    await db.withService(t.db, (tx) => dbAny.updateAiBudgetSettings!(tx, { monthlyCapMicros: 0 }))
    try {
      const r = await transcribeJournalRecording({ run: ownerRun, transcriber: transcriberWith(fetch), now: () => T0 }, id)
      expect(r.status === 'failed' && r.reason).toBe('budget_exhausted')
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await db.withService(t.db, (tx) => dbAny.updateAiBudgetSettings!(tx, defaults))
    }
  })

  it('no API key: not configured, nothing is sent', async () => {
    const { id } = await uploaded('audio/webm')
    const fetch = vi.fn(async () => transcriptResponse('should not happen'))
    const r = await transcribeJournalRecording(
      { run: ownerRun, transcriber: transcriberWith(fetch, null), now: () => T0 },
      id,
    )
    expect(r.status === 'failed' && r.reason).toBe('not_configured')
    expect(fetch).not.toHaveBeenCalled()
  })
})
