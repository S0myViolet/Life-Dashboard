/**
 * The browser upload client against the REAL route handlers and a real Postgres (owner
 * transactions, RLS). Only the session lookup and the transcriber are substituted: requests are
 * routed straight to the handlers instead of over HTTP.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { JOURNAL_CHUNK_BYTES } from '@personal-home/core'
import { getJournalEntry, withOwner, type OwnerClaims } from '@personal-home/db'
import { createTestDatabase, seedOwner, type TestDatabase } from '@personal-home/db/testing'
import { notConfiguredJournalTranscriber, type JournalTranscriber } from '@personal-home/jobs'

declare module 'vitest' {
  export interface ProvidedContext {
    templateDb: string
  }
}

let t: TestDatabase
let owner: OwnerClaims
let signedIn = true
let transcriber: JournalTranscriber = notConfiguredJournalTranscriber

vi.mock('@/lib/server/session', () => ({
  getOwner: async () => (signedIn ? { claims: owner, userId: owner.sub, email: owner.email ?? null } : null),
  requireOwner: async () => ({ claims: owner, userId: owner.sub, email: owner.email ?? null }),
}))
vi.mock('@/lib/server/db', () => ({
  ownerTransaction: (claims: OwnerClaims, fn: Parameters<typeof withOwner>[2]) => withOwner(t.db, claims, fn),
}))
vi.mock('@/app/api/journal/_lib/transcriber', () => ({ getJournalTranscriber: async () => transcriber }))

const recordings = await import('@/app/api/journal/recordings/route')
const recording = await import('@/app/api/journal/recordings/[id]/route')
const chunk = await import('@/app/api/journal/recordings/[id]/chunks/[seq]/route')
const complete = await import('@/app/api/journal/recordings/[id]/complete/route')
const retry = await import('@/app/api/journal/recordings/[id]/retry/route')
const audioRoute = await import('@/app/api/journal/recordings/[id]/audio/route')
const { uploadJournalRecording } = await import('@/lib/recording/upload')
const { saveJournalTranscriptAction } = await import('@/app/(app)/capture/actions')

type Call = { method: string; path: string; bytes: number }
let calls: Call[] = []
let failNext: ((c: Call) => boolean) | null = null

/** Route a fetch to the matching handler, like Next would. */
async function appFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, 'http://localhost')
  const method = (init.method ?? 'GET').toUpperCase()
  const body = init.body as Uint8Array | string | undefined
  const call: Call = { method, path: url.pathname, bytes: typeof body === 'string' ? body.length : (body?.byteLength ?? 0) }
  if (failNext?.(call)) {
    failNext = null
    throw new TypeError('Failed to fetch')
  }
  calls.push(call)
  const req = new Request(url, { method, headers: init.headers, body: body as BodyInit | undefined })
  const m = url.pathname.match(/^\/api\/journal\/recordings(?:\/([^/]+))?(?:\/(chunks)\/([^/]+)|\/(complete|retry|audio))?$/)
  if (!m) return new Response('no route', { status: 404 })
  const [, id, isChunk, seq, action] = m
  const params = Promise.resolve({ id: id!, seq: seq! })
  if (!id && method === 'POST') return recordings.POST(req)
  if (isChunk && method === 'PUT') return chunk.PUT(req, { params })
  if (action === 'complete' && method === 'POST') return complete.POST(req, { params })
  if (action === 'retry' && method === 'POST') return retry.POST(req, { params })
  if (action === 'audio' && method === 'GET') return audioRoute.GET(req, { params })
  if (id && !action && method === 'GET') return recording.GET(req, { params })
  if (id && !action && method === 'DELETE') return recording.DELETE(req, { params })
  return new Response('method', { status: 405 })
}

let dateSeq = 0
const freshDate = () => new Date(Date.UTC(2022, 0, 1) + ++dateSeq * 86_400_000).toISOString().slice(0, 10)

function localRecording(bytes: number, mimeType = 'audio/webm;codecs=opus') {
  return { id: randomUUID(), localDate: freshDate(), mimeType, durationSeconds: 42.5, data: new Uint8Array(randomBytes(bytes)) }
}

beforeAll(async () => {
  t = await createTestDatabase()
  owner = await seedOwner(t.db)
})
afterAll(async () => {
  await t?.drop()
})
beforeEach(() => {
  calls = []
  failNext = null
  signedIn = true
  transcriber = notConfiguredJournalTranscriber
})

const deps = { fetch: appFetch, sleep: async () => {} }

describe('upload → transcription failure (AI not configured)', () => {
  it('uploads in ≤1 MB chunks and keeps the recording with a seven-day expiry', async () => {
    const rec = localRecording(2 * JOURNAL_CHUNK_BYTES + 12_345)
    const outcome = await uploadJournalRecording(rec, deps)
    expect(outcome.status).toBe('uploaded')
    if (outcome.status !== 'uploaded') return
    expect(outcome.result).toMatchObject({ status: 'failed', reason: 'not_configured' })
    const puts = calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(3)
    expect(Math.max(...puts.map((c) => c.bytes))).toBeLessThanOrEqual(1_000_000)

    const [row] = await t.db<{ status: string; failureReason: string; ttl: string; chunks: number }[]>`
      select r.status, r.failure_reason, (r.expires_at - r.created_at)::text as ttl,
        (select count(*)::int from public.journal_recording_chunks c where c.recording_id = r.id) as chunks
      from public.journal_recordings r where r.id = ${rec.id}
    `
    expect(row).toEqual({ status: 'failed', failureReason: 'not_configured', ttl: '7 days', chunks: 3 })

    // Download returns exactly what was recorded.
    const res = await appFetch(`/api/journal/recordings/${rec.id}/audio`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/webm;codecs=opus')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="journal-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.webm"/)
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(rec.data))).toBe(true)
  })

  it('resumes after a dropped connection, sending only the missing chunks', async () => {
    const rec = localRecording(3 * JOURNAL_CHUNK_BYTES)
    failNext = (c) => c.method === 'PUT' && c.path.endsWith('/chunks/1')
    const first = await uploadJournalRecording(rec, { ...deps, maxAttempts: 1 })
    expect(first).toEqual({ status: 'failed', code: 'offline', retryable: true })

    calls = []
    const second = await uploadJournalRecording(rec, deps)
    expect(second.status).toBe('uploaded')
    const sentChunks = calls.filter((c) => c.method === 'PUT').map((c) => c.path.split('/').pop())
    expect(sentChunks).toEqual(['1', '2'])

    // Repeating the whole upload of a finished recording is a no-op (no chunks, no second transcription).
    calls = []
    const third = await uploadJournalRecording(rec, deps)
    expect(third).toMatchObject({ status: 'uploaded', result: null })
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
    const [{ attempts }] = (await t.db`select attempts from public.journal_recordings where id = ${rec.id}`) as unknown as [
      { attempts: number },
    ]
    expect(attempts).toBe(1)
  })

  it('refuses to replace a stored chunk with different bytes', async () => {
    const rec = localRecording(JOURNAL_CHUNK_BYTES + 10)
    failNext = (c) => c.method === 'PUT' && c.path.endsWith('/chunks/1')
    await uploadJournalRecording(rec, { ...deps, maxAttempts: 1 })
    // Same size, different bytes for the stored chunk 0: the server keeps the original.
    const res = await appFetch(`/api/journal/recordings/${rec.id}/chunks/0`, {
      method: 'PUT',
      body: new Uint8Array(randomBytes(JOURNAL_CHUNK_BYTES)),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'mismatch' })
    // The genuine bytes are still accepted as an idempotent repeat.
    const again = await appFetch(`/api/journal/recordings/${rec.id}/chunks/0`, {
      method: 'PUT',
      body: rec.data.slice(0, JOURNAL_CHUNK_BYTES),
    })
    expect(await again.json()).toEqual({ status: 'duplicate', received: 1, expected: 2 })
    // Registering the same id with a different size is a clash, not an overwrite.
    const clash = await uploadJournalRecording({ ...rec, data: rec.data.slice(0, 100) }, deps)
    expect(clash).toEqual({ status: 'failed', code: 'id_conflict', retryable: false })
  })

  it('reports signed-out uploads as retryable and keeps nothing half-registered', async () => {
    signedIn = false
    const r = await uploadJournalRecording(localRecording(100), deps)
    expect(r).toEqual({ status: 'failed', code: 'signed_out', retryable: true })
  })
})

describe('transcription paths with a fake transcriber', () => {
  it('success: transcript becomes a draft; adding it deletes the recording', async () => {
    const seen: Array<{ mimeType: string; bytes: number; duration: number | null }> = []
    transcriber = async (audio) => {
      seen.push({ mimeType: audio.mimeType, bytes: audio.bytes.byteLength, duration: audio.durationSeconds })
      return { status: 'ok', text: 'Fake transcript of my day.' }
    }
    const rec = localRecording(5000)
    const out = await uploadJournalRecording(rec, deps)
    expect(out.status === 'uploaded' && out.result?.status).toBe('transcribed')
    expect(seen).toEqual([{ mimeType: 'audio/webm;codecs=opus', bytes: 5000, duration: 42.5 }])

    const entry = await withOwner(t.db, owner, (tx) => getJournalEntry(tx, rec.localDate))
    expect(entry).toMatchObject({ body: '', transcriptDraft: 'Fake transcript of my day.', transcriptStatus: 'ready_for_review' })

    const saved = await saveJournalTranscriptAction({
      localDate: rec.localDate,
      baseVersion: entry!.version,
      draftSeen: entry!.transcriptDraft!,
      text: 'My day, edited.',
    })
    expect(saved).toMatchObject({ status: 'saved', recordingsDeleted: 1, entry: { body: 'My day, edited.', transcriptDraft: null } })
    expect((await appFetch(`/api/journal/recordings/${rec.id}`)).status).toBe(404)
  })

  it('budget exhausted: the recording is kept and a later retry succeeds', async () => {
    transcriber = async () => ({ status: 'budget_exhausted', reason: 'budget_exhausted' })
    const rec = localRecording(700, 'audio/mp4')
    const out = await uploadJournalRecording(rec, deps)
    expect(out.status === 'uploaded' && out.result).toMatchObject({ status: 'failed', reason: 'budget_exhausted' })

    transcriber = async () => ({ status: 'ok', text: 'Next month.' })
    const res = await appFetch(`/api/journal/recordings/${rec.id}/retry`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await res.json()).result).toMatchObject({ status: 'transcribed', recording: { attempts: 2 } })
  })

  it('iPhone audio/mp4 refused by the provider stays failed and downloadable', async () => {
    transcriber = async () => ({ status: 'failed', reason: 'provider_rejected' })
    const rec = localRecording(900, 'audio/mp4')
    const out = await uploadJournalRecording(rec, deps)
    expect(out.status === 'uploaded' && out.result).toMatchObject({ status: 'failed', reason: 'provider_rejected' })
    const res = await appFetch(`/api/journal/recordings/${rec.id}/audio`)
    expect(res.headers.get('content-type')).toBe('audio/mp4')
    expect(res.headers.get('content-disposition')).toMatch(/\.m4a"$/)
  })
})

describe('route guards', () => {
  it('401 without the owner, 403 cross-site, 413 oversized chunks, 400/404 for bad ids', async () => {
    const rec = localRecording(JOURNAL_CHUNK_BYTES + 1)
    await appFetch('/api/journal/recordings', {
      method: 'POST',
      body: JSON.stringify({ id: rec.id, localDate: rec.localDate, mimeType: rec.mimeType, byteSize: rec.data.byteLength, chunkBytes: JOURNAL_CHUNK_BYTES, durationSeconds: 1 }),
    })

    const tooBig = await appFetch(`/api/journal/recordings/${rec.id}/chunks/0`, { method: 'PUT', body: new Uint8Array(1_048_577) })
    expect(tooBig.status).toBe(413)
    expect((await appFetch(`/api/journal/recordings/${rec.id}/chunks/99`, { method: 'PUT', body: new Uint8Array(1) })).status).toBe(400)
    expect((await appFetch(`/api/journal/recordings/${rec.id}/chunks/-1`, { method: 'PUT', body: new Uint8Array(1) })).status).toBe(400)
    expect((await appFetch(`/api/journal/recordings/not-a-uuid`)).status).toBe(404)
    const wrongSize = await appFetch(`/api/journal/recordings/${rec.id}/chunks/0`, { method: 'PUT', body: new Uint8Array(10) })
    expect(wrongSize.status).toBe(400)
    expect(await wrongSize.json()).toEqual({ error: 'invalid_size', expectedSize: JOURNAL_CHUNK_BYTES })

    const cross = await appFetch(`/api/journal/recordings/${rec.id}`, {
      method: 'DELETE',
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    })
    expect(cross.status).toBe(403)

    signedIn = false
    expect((await appFetch(`/api/journal/recordings/${rec.id}`)).status).toBe(401)
    expect((await appFetch(`/api/journal/recordings/${rec.id}/audio`)).status).toBe(401)
    signedIn = true
    expect((await appFetch(`/api/journal/recordings/${rec.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await appFetch(`/api/journal/recordings/${rec.id}`)).status).toBe(404)
  })

  it('rejects malformed registrations', async () => {
    const bad = await appFetch('/api/journal/recordings', { method: 'POST', body: '{"id":"x"' })
    expect(bad.status).toBe(400)
    const html = await appFetch('/api/journal/recordings', {
      method: 'POST',
      body: JSON.stringify({ id: randomUUID(), localDate: freshDate(), mimeType: 'text/html', byteSize: 10, chunkBytes: JOURNAL_CHUNK_BYTES, durationSeconds: 1 }),
    })
    expect(html.status).toBe(400)
    const huge = await appFetch('/api/journal/recordings', { method: 'POST', body: 'x'.repeat(5000) })
    expect(huge.status).toBe(413)
  })
})
