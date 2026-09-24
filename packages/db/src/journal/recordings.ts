/**
 * Voice journal recordings stored in Postgres as ≤1 MB chunks (public.journal_recordings +
 * public.journal_recording_chunks), owner-scoped by RLS.
 *
 * Upload is resumable and idempotent: the device generates the recording id, every chunk has a
 * fixed size and sequence number, a repeated chunk with identical bytes is accepted as a no-op,
 * and a different payload for a stored chunk is refused (never silently replaced).
 *
 * Transcription attempts are fenced: beginning one sets status 'transcribing' and increments
 * `attempts`; finishing it only lands if the status and attempt number still match, so a late
 * result from an interrupted attempt can never overwrite a newer one.
 *
 * Retention: `expires_at` is fixed at creation (seven days, enforced by a check constraint);
 * reads ignore expired rows and purgeExpiredRecordings() deletes them.
 */
import {
  JOURNAL_BODY_MAX,
  JournalRecordingCreateSchema,
  JournalRecordingFailureReasonSchema,
  journalAppendText,
  journalChunkCount,
  journalChunkSize,
  journalMissingChunks,
  journalRecordingExpiresAt,
  journalTranscriptionIsStale,
  notesZodIssues,
  type JournalRecordingCreateInput,
  type JournalRecordingFailureReason,
  type JournalRecordingStatus,
  type JournalRecordingView,
} from '@personal-home/core'
import type { Tx } from '../client.ts'
import { ensureJournalEntry, refreshJournalTranscriptStatus } from './entries.ts'

interface RecordingDbRow {
  id: string
  entryId: string
  localDate: string
  mimeType: string
  byteSize: number
  chunkBytes: number
  expectedChunks: number
  receivedChunks: number[]
  durationSeconds: number | null
  status: JournalRecordingStatus
  failureReason: string | null
  attempts: number
  createdAt: Date
  expiresAt: Date
  transcribingSince: Date | null
}

function failureReasonOf(raw: string | null): JournalRecordingFailureReason | null {
  if (raw === null) return null
  const parsed = JournalRecordingFailureReasonSchema.safeParse(raw)
  return parsed.success ? parsed.data : 'provider_error'
}

function toRecordingView(r: RecordingDbRow): JournalRecordingView {
  return {
    id: r.id,
    entryId: r.entryId,
    localDate: r.localDate,
    mimeType: r.mimeType,
    byteSize: r.byteSize,
    chunkBytes: r.chunkBytes,
    expectedChunks: r.expectedChunks,
    receivedChunks: [...(r.receivedChunks ?? [])],
    durationSeconds: r.durationSeconds === null ? null : Number(r.durationSeconds),
    status: r.status,
    failureReason: failureReasonOf(r.failureReason),
    attempts: r.attempts,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    transcribingSince: r.transcribingSince ? r.transcribingSince.toISOString() : null,
  }
}

async function selectRecordings(
  tx: Tx,
  where: { id?: string; entryId?: string; localDate?: string },
  now: Date,
  lock: '' | 'update' = '',
): Promise<RecordingDbRow[]> {
  // Row locks cannot be combined with the aggregate subquery, so lock first when asked.
  if (lock === 'update' && where.id) {
    await tx`select 1 from public.journal_recordings where id = ${where.id}::uuid for update`
  }
  const rows = await tx<RecordingDbRow[]>`
    select r.id, r.entry_id, e.local_date, r.mime_type, r.byte_size, r.chunk_bytes, r.expected_chunks,
      coalesce((select array_agg(c.seq order by c.seq) from public.journal_recording_chunks c
                where c.recording_id = r.id), '{}'::int[]) as received_chunks,
      r.duration_seconds::float8 as duration_seconds, r.status, r.failure_reason, r.attempts,
      r.created_at, r.expires_at, r.transcribing_since
    from public.journal_recordings r
    join public.journal_entries e on e.id = r.entry_id
    where r.expires_at > ${now}::timestamptz
      and (${where.id ?? null}::uuid is null or r.id = ${where.id ?? null}::uuid)
      and (${where.entryId ?? null}::uuid is null or r.entry_id = ${where.entryId ?? null}::uuid)
      and (${where.localDate ?? null}::date is null or e.local_date = ${where.localDate ?? null}::date)
    order by r.created_at, r.id
  `
  return [...rows]
}

/** A live (unexpired) recording, or null. */
export async function getJournalRecording(
  tx: Tx,
  id: string,
  now: Date = new Date(),
): Promise<JournalRecordingView | null> {
  const [row] = await selectRecordings(tx, { id }, now)
  return row ? toRecordingView(row) : null
}

/** Live recordings, oldest first; optionally for one entry or local date. */
export async function listJournalRecordings(
  tx: Tx,
  o: { entryId?: string; localDate?: string; now?: Date } = {},
): Promise<JournalRecordingView[]> {
  const rows = await selectRecordings(tx, { entryId: o.entryId, localDate: o.localDate }, o.now ?? new Date())
  return rows.map(toRecordingView)
}

export type CreateJournalRecordingResult =
  | { status: 'created' | 'exists'; recording: JournalRecordingView }
  /** The id is taken by a recording with different parameters (never reused). */
  | { status: 'id_conflict' }
  | { status: 'invalid'; issues: string[] }

/**
 * Register a recording before its chunks are uploaded. Creates the day's entry if needed.
 * Idempotent on the device-generated id.
 */
export async function createJournalRecording(
  tx: Tx,
  input: JournalRecordingCreateInput,
  now: Date = new Date(),
): Promise<CreateJournalRecordingResult> {
  const parsed = JournalRecordingCreateSchema.safeParse(input)
  if (!parsed.success) return { status: 'invalid', issues: notesZodIssues(parsed.error) }
  const v = parsed.data
  const expected = journalChunkCount(v.byteSize, v.chunkBytes)
  const entry = await ensureJournalEntry(tx, v.localDate, 'voice')

  const inserted = await tx`
    insert into public.journal_recordings
      (id, entry_id, mime_type, byte_size, chunk_bytes, expected_chunks, duration_seconds, status, created_at, expires_at)
    values (${v.id}::uuid, ${entry.id}::uuid, ${v.mimeType}, ${v.byteSize}, ${v.chunkBytes}, ${expected},
            ${v.durationSeconds}, 'uploading', ${now}::timestamptz, ${journalRecordingExpiresAt(now)}::timestamptz)
    on conflict (id) do nothing
    returning id
  `
  if (inserted.length > 0) {
    await refreshJournalTranscriptStatus(tx, entry.id)
    const recording = await getJournalRecording(tx, v.id, now)
    if (!recording) throw new Error('recording is not visible after insert')
    return { status: 'created', recording }
  }
  const existing = await getJournalRecording(tx, v.id, now)
  if (
    existing &&
    existing.localDate === v.localDate &&
    existing.mimeType === v.mimeType &&
    existing.byteSize === v.byteSize &&
    existing.chunkBytes === v.chunkBytes
  ) {
    return { status: 'exists', recording: existing }
  }
  return { status: 'id_conflict' }
}

export type PutJournalChunkResult =
  | { status: 'stored' | 'duplicate'; received: number; expected: number }
  | { status: 'not_found' }
  /** seq outside the recording, or a size that does not match the fixed chunk plan. */
  | { status: 'invalid_seq' | 'invalid_size'; expectedSize: number | null }
  /** A stored chunk already has different bytes: never replaced. */
  | { status: 'mismatch' }
  /** The upload was already completed; only identical repeats are accepted. */
  | { status: 'not_uploading' }

/** Store one chunk. Safe to repeat; concurrent writers of different chunks do not block each other. */
export async function putJournalRecordingChunk(
  tx: Tx,
  input: { recordingId: string; seq: number; data: Uint8Array },
  now: Date = new Date(),
): Promise<PutJournalChunkResult> {
  const [rec] = await tx<
    Array<{ status: JournalRecordingStatus; byteSize: number; chunkBytes: number; expectedChunks: number }>
  >`
    select status, byte_size, chunk_bytes, expected_chunks from public.journal_recordings
    where id = ${input.recordingId}::uuid and expires_at > ${now}::timestamptz
    for share
  `
  if (!rec) return { status: 'not_found' }
  const expectedSize = journalChunkSize(rec.byteSize, rec.chunkBytes, input.seq)
  if (expectedSize === null) return { status: 'invalid_seq', expectedSize: null }
  if (input.data.byteLength !== expectedSize) return { status: 'invalid_size', expectedSize }

  let stored = false
  if (rec.status === 'uploading') {
    const rows = await tx`
      insert into public.journal_recording_chunks (recording_id, seq, data)
      values (${input.recordingId}::uuid, ${input.seq}, ${input.data})
      on conflict (recording_id, seq) do nothing
      returning seq
    `
    stored = rows.length > 0
  }
  if (!stored) {
    const [same] = await tx<{ same: boolean }[]>`
      select data = ${input.data} as same from public.journal_recording_chunks
      where recording_id = ${input.recordingId}::uuid and seq = ${input.seq}
    `
    // No stored chunk (upload already completed) or different bytes: refuse, never replace.
    if (!same?.same) return { status: rec.status === 'uploading' ? 'mismatch' : 'not_uploading' }
  }
  const [count] = await tx<{ n: number }[]>`
    select count(*)::int as n from public.journal_recording_chunks where recording_id = ${input.recordingId}::uuid
  `
  return { status: stored ? 'stored' : 'duplicate', received: count?.n ?? 0, expected: rec.expectedChunks }
}

export type CompleteJournalUploadResult =
  | { status: 'uploaded'; recording: JournalRecordingView }
  /** Already past the upload stage (a repeated complete call). */
  | { status: 'already'; recording: JournalRecordingView }
  | { status: 'incomplete'; missing: number[]; recording: JournalRecordingView }
  | { status: 'not_found' }

/** Verify every chunk is present with its planned size, then mark the recording uploaded. */
export async function completeJournalRecordingUpload(
  tx: Tx,
  id: string,
  now: Date = new Date(),
): Promise<CompleteJournalUploadResult> {
  const [row] = await selectRecordings(tx, { id }, now, 'update')
  if (!row) return { status: 'not_found' }
  if (row.status !== 'uploading') return { status: 'already', recording: toRecordingView(row) }

  const chunks = await tx<{ seq: number; size: number }[]>`
    select seq, octet_length(data)::int as size from public.journal_recording_chunks
    where recording_id = ${id}::uuid order by seq
  `
  // Sizes are checked on write; re-check so a bad row can never be assembled into audio.
  const good = chunks.filter((c) => journalChunkSize(row.byteSize, row.chunkBytes, c.seq) === c.size)
  const missing = journalMissingChunks(row.expectedChunks, good.map((c) => c.seq))
  if (missing.length > 0) return { status: 'incomplete', missing, recording: toRecordingView(row) }

  await tx`
    update public.journal_recordings set status = 'uploaded', uploaded_at = ${now}::timestamptz
    where id = ${id}::uuid
  `
  await refreshJournalTranscriptStatus(tx, row.entryId)
  const recording = await getJournalRecording(tx, id, now)
  return { status: 'uploaded', recording: recording! }
}

async function assembleAudio(tx: Tx, id: string, byteSize: number): Promise<Uint8Array> {
  const chunks = await tx<{ seq: number; data: Uint8Array }[]>`
    select seq, data from public.journal_recording_chunks where recording_id = ${id}::uuid order by seq
  `
  const out = new Uint8Array(byteSize)
  let offset = 0
  for (const c of chunks) {
    if (offset + c.data.byteLength > byteSize) throw new Error('recording chunks exceed the recorded size')
    out.set(c.data, offset)
    offset += c.data.byteLength
  }
  if (offset !== byteSize) throw new Error('recording chunks do not add up to the recorded size')
  return out
}

/** The complete audio of an uploaded recording, for download. Null when absent, expired or incomplete. */
export async function readJournalRecordingAudio(
  tx: Tx,
  id: string,
  now: Date = new Date(),
): Promise<{ recording: JournalRecordingView; audio: Uint8Array } | null> {
  const recording = await getJournalRecording(tx, id, now)
  if (!recording || recording.status === 'uploading') return null
  return { recording, audio: await assembleAudio(tx, id, recording.byteSize) }
}

export type BeginJournalTranscriptionResult =
  | {
      status: 'claimed'
      /** Fencing token for finishJournalTranscription. */
      attempt: number
      recording: JournalRecordingView
      audio: Uint8Array
    }
  | { status: 'in_progress'; recording: JournalRecordingView }
  | { status: 'incomplete'; missing: number[]; recording: JournalRecordingView }
  | { status: 'not_retryable'; recording: JournalRecordingView }
  | { status: 'not_found' }

/**
 * Take a recording for one transcription attempt: from 'uploaded', from 'failed' (retry), or from
 * a 'transcribing' attempt that went stale. Returns the assembled audio.
 */
export async function beginJournalTranscription(
  tx: Tx,
  id: string,
  now: Date = new Date(),
): Promise<BeginJournalTranscriptionResult> {
  const [row] = await selectRecordings(tx, { id }, now, 'update')
  if (!row) return { status: 'not_found' }
  const view = toRecordingView(row)
  if (row.status === 'uploading') {
    return { status: 'incomplete', missing: journalMissingChunks(row.expectedChunks, row.receivedChunks), recording: view }
  }
  if (row.status === 'transcribing' && !journalTranscriptionIsStale(row.transcribingSince, now)) {
    return { status: 'in_progress', recording: view }
  }
  if (row.status === 'transcribed') return { status: 'not_retryable', recording: view }

  const [claimed] = await tx<{ attempts: number }[]>`
    update public.journal_recordings set
      status = 'transcribing',
      transcribing_since = ${now}::timestamptz,
      last_attempt_at = ${now}::timestamptz,
      attempts = attempts + 1,
      failure_reason = null
    where id = ${id}::uuid
    returning attempts
  `
  await refreshJournalTranscriptStatus(tx, row.entryId)
  const audio = await assembleAudio(tx, id, row.byteSize)
  const recording = await getJournalRecording(tx, id, now)
  return { status: 'claimed', attempt: claimed!.attempts, recording: recording!, audio }
}

export type JournalTranscriptionOutcome =
  | { kind: 'transcript'; text: string }
  | { kind: 'failure'; reason: JournalRecordingFailureReason }

export type FinishJournalTranscriptionResult =
  | { status: 'transcribed'; recording: JournalRecordingView }
  | { status: 'failed'; reason: JournalRecordingFailureReason; recording: JournalRecordingView }
  /** The recording was deleted (owner or retention) while the attempt ran. */
  | { status: 'deleted' }
  /** A newer attempt owns the recording now; this result was not stored. */
  | { status: 'superseded'; recording: JournalRecordingView }

/**
 * Record the outcome of an attempt. A transcript is appended to the entry's review draft (never
 * to the entry text itself) and the recording is kept until the owner saves the transcript.
 * An empty transcript is a failure, never an empty entry.
 */
export async function finishJournalTranscription(
  tx: Tx,
  input: { id: string; attempt: number; outcome: JournalTranscriptionOutcome },
  now: Date = new Date(),
): Promise<FinishJournalTranscriptionResult> {
  const [row] = await selectRecordings(tx, { id: input.id }, now, 'update')
  if (!row) return { status: 'deleted' }
  if (row.status !== 'transcribing' || row.attempts !== input.attempt) {
    return { status: 'superseded', recording: toRecordingView(row) }
  }

  let failure: JournalRecordingFailureReason | null =
    input.outcome.kind === 'failure' ? input.outcome.reason : null
  if (input.outcome.kind === 'transcript') {
    const text = input.outcome.text
    if (text.replace(/\u0000/g, '').trim() === '') {
      failure = 'empty_transcript'
    } else {
      const [entry] = await tx<{ transcriptDraft: string | null }[]>`
        select transcript_draft from public.journal_entries where id = ${row.entryId}::uuid for update
      `
      const draft = journalAppendText(entry?.transcriptDraft ?? null, text.replace(/\u0000/g, ''))
      if (draft.length > JOURNAL_BODY_MAX) {
        failure = 'draft_full'
      } else {
        await tx`update public.journal_entries set transcript_draft = ${draft} where id = ${row.entryId}::uuid`
        await tx`
          update public.journal_recordings set status = 'transcribed', transcribing_since = null, failure_reason = null
          where id = ${input.id}::uuid
        `
      }
    }
  }
  if (failure) {
    await tx`
      update public.journal_recordings set status = 'failed', transcribing_since = null, failure_reason = ${failure}
      where id = ${input.id}::uuid
    `
  }
  await refreshJournalTranscriptStatus(tx, row.entryId)
  const recording = (await getJournalRecording(tx, input.id, now))!
  return failure ? { status: 'failed', reason: failure, recording } : { status: 'transcribed', recording }
}

/** Owner "Delete" (also allowed mid-upload). */
export async function deleteJournalRecording(tx: Tx, id: string): Promise<boolean> {
  const [row] = await tx<{ entryId: string }[]>`
    delete from public.journal_recordings where id = ${id}::uuid returning entry_id
  `
  if (!row) return false
  await refreshJournalTranscriptStatus(tx, row.entryId)
  return true
}

/**
 * Retention: delete every recording whose expiry has passed (chunks cascade). For the
 * retention.purge job (service transaction) and opportunistically when the owner opens the
 * journal (owner transaction; RLS permits the delete). Transcript drafts live on the entry and
 * are untouched.
 */
export async function purgeExpiredRecordings(tx: Tx, now: Date): Promise<{ deleted: number }> {
  const rows = await tx<{ entryId: string }[]>`
    delete from public.journal_recordings where expires_at <= ${now}::timestamptz returning entry_id
  `
  for (const entryId of new Set(rows.map((r) => r.entryId))) await refreshJournalTranscriptStatus(tx, entryId)
  return { deleted: rows.length }
}
