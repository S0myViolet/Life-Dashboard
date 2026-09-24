/**
 * Voice journal recordings: recorder MIME selection, chunked upload plan, retention and the
 * owner-facing failure vocabulary.
 *
 * Formats (docs/research/gemini.md, 2026-09-24): desktop Chrome records audio/webm;codecs=opus,
 * which the Gemini Developer API lists. iPhone Safari records audio/mp4 (AAC), which is NOT on the
 * Developer API's list; the gateway sends it relabelled as audio/m4a, unverified. If the provider
 * rejects it, the recording is marked failed and kept — a transcript is never invented.
 */
import { z } from 'zod'
import { CalendarDateSchema } from '../time/index.ts'

/** Longest recording the recorder allows (a visible timer counts down to it). */
export const JOURNAL_RECORDING_MAX_SECONDS = 15 * 60
/** Voice-quality bitrate hint for MediaRecorder; keeps 15 minutes well under the upload cap. */
export const JOURNAL_RECORDER_BITS_PER_SECOND = 48_000
/** Upload chunk size. Vercel functions accept ~4.5 MB bodies; 1 MB leaves ample headroom. */
export const JOURNAL_CHUNK_BYTES = 1_000_000
export const JOURNAL_CHUNK_MIN_BYTES = 65_536
/** Largest chunk the server stores (the database check allows 1 MiB). */
export const JOURNAL_CHUNK_MAX_BYTES = 1_048_576
export const JOURNAL_RECORDING_MAX_CHUNKS = 64
/** Mirrors the database check on journal_recordings.byte_size (25 MiB). */
export const JOURNAL_RECORDING_MAX_BYTES = 26_214_400
export const JOURNAL_RECORDING_RETENTION_DAYS = 7
/** A transcription attempt that has held a recording this long is presumed dead and can be retried. */
export const JOURNAL_TRANSCRIPTION_STALE_MS = 10 * 60_000

/** Preferred recorder formats, best first. The first one MediaRecorder supports wins. */
export const JOURNAL_RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus', // Chrome, Edge, Firefox, Safari 18.4+
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2', // iPhone Safari (AAC)
  'audio/mp4',
  'audio/ogg;codecs=opus',
] as const

/**
 * Pick the recorder MIME type at runtime. Returns null when MediaRecorder cannot report support
 * (or supports none of the candidates): the caller then lets the browser choose its default and
 * reads `recorder.mimeType` afterwards.
 */
export function journalPickRecorderMimeType(
  isTypeSupported: ((type: string) => boolean) | null | undefined,
): string | null {
  if (typeof isTypeSupported !== 'function') return null
  for (const candidate of JOURNAL_RECORDER_MIME_CANDIDATES) {
    try {
      if (isTypeSupported(candidate)) return candidate
    } catch {
      // Some engines throw for unknown types; treat as unsupported.
    }
  }
  return null
}

const AUDIO_BASES = [
  'audio/webm',
  'audio/mp4',
  'audio/ogg',
  'audio/mpeg',
  'audio/aac',
  'audio/m4a',
  'audio/x-m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
] as const
export type JournalAudioBase = (typeof AUDIO_BASES)[number]
const AUDIO_BASE_SET: ReadonlySet<string> = new Set(AUDIO_BASES)

/** Stored/uploaded recording type: an audio base type with an optional codecs parameter. */
export const JournalRecordingMimeSchema = z
  .string()
  .max(100)
  .transform((v) => v.trim().toLowerCase().replace(/\s*;\s*/g, ';'))
  .refine((v) => /^audio\/[a-z0-9.+-]+(;codecs="?[a-z0-9.,+ -]{1,60}"?)?$/.test(v), 'unsupported audio type')
  .refine((v) => AUDIO_BASE_SET.has(v.split(';')[0]!), 'unsupported audio type')

/**
 * Normalise what the recorder reported. Audio-only WebM/MP4 is sometimes labelled video/*; the
 * research notes found the provider returns an empty transcript for video/webm, so relabel it.
 * Returns null for anything that is not a recognised audio format.
 */
export function journalNormalizeRecordedMime(...candidates: Array<string | null | undefined>): string | null {
  for (const raw of candidates) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const relabelled = raw.trim().replace(/^video\/(webm|mp4)/i, 'audio/$1')
    const parsed = JournalRecordingMimeSchema.safeParse(relabelled)
    if (parsed.success) return parsed.data
  }
  return null
}

export function journalAudioBase(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase()
}

/** File extension for downloads. */
export function journalRecordingFileExtension(mime: string): string {
  switch (journalAudioBase(mime)) {
    case 'audio/webm':
      return 'webm'
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
    case 'audio/aac':
      return 'm4a'
    case 'audio/ogg':
      return 'ogg'
    case 'audio/mpeg':
      return 'mp3'
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav'
    case 'audio/flac':
      return 'flac'
    default:
      return 'audio'
  }
}

/** True for the iPhone Safari format the provider does not list (sent relabelled, unverified). */
export function journalIsUnverifiedTranscriptionFormat(mime: string): boolean {
  return journalAudioBase(mime) === 'audio/mp4'
}

// ---------------------------------------------------------------------------
// Chunk plan
// ---------------------------------------------------------------------------

export function journalChunkCount(byteSize: number, chunkBytes: number): number {
  if (!Number.isSafeInteger(byteSize) || byteSize < 1) throw new RangeError('byteSize must be a positive integer')
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new RangeError('chunkBytes must be a positive integer')
  return Math.ceil(byteSize / chunkBytes)
}

/** Exact size chunk `seq` must have, or null when `seq` is outside the recording. */
export function journalChunkSize(byteSize: number, chunkBytes: number, seq: number): number | null {
  const count = journalChunkCount(byteSize, chunkBytes)
  if (!Number.isInteger(seq) || seq < 0 || seq >= count) return null
  return seq < count - 1 ? chunkBytes : byteSize - chunkBytes * (count - 1)
}

/** Sequence numbers still missing, ascending. */
export function journalMissingChunks(expectedChunks: number, received: Iterable<number>): number[] {
  const have = new Set(received)
  const missing: number[] = []
  for (let s = 0; s < expectedChunks; s++) if (!have.has(s)) missing.push(s)
  return missing
}

/** Byte range [start, end) of chunk `seq` in the recording. */
export function journalChunkRange(byteSize: number, chunkBytes: number, seq: number): [number, number] {
  const size = journalChunkSize(byteSize, chunkBytes, seq)
  if (size === null) throw new RangeError('chunk sequence out of range')
  const start = seq * chunkBytes
  return [start, start + size]
}

export const JournalRecordingCreateSchema = z
  .object({
    /** Generated on the device, so a retried create is idempotent. */
    id: z.uuid(),
    localDate: CalendarDateSchema,
    mimeType: JournalRecordingMimeSchema,
    byteSize: z.number().int().min(1).max(JOURNAL_RECORDING_MAX_BYTES),
    chunkBytes: z.number().int().min(JOURNAL_CHUNK_MIN_BYTES).max(JOURNAL_CHUNK_MAX_BYTES),
    durationSeconds: z.number().min(0).max(3600).nullable(),
  })
  // Zod runs object refinements even when a field already failed, so guard the arithmetic.
  .refine((v) => Math.ceil(v.byteSize / v.chunkBytes) <= JOURNAL_RECORDING_MAX_CHUNKS, {
    message: 'too many chunks',
    path: ['chunkBytes'],
  })
export type JournalRecordingCreateInput = z.input<typeof JournalRecordingCreateSchema>

// ---------------------------------------------------------------------------
// Status, failures, retention
// ---------------------------------------------------------------------------

export const JOURNAL_RECORDING_STATUSES = ['uploading', 'uploaded', 'transcribing', 'transcribed', 'failed'] as const
export type JournalRecordingStatus = (typeof JOURNAL_RECORDING_STATUSES)[number]

export const JOURNAL_RECORDING_FAILURE_REASONS = [
  'not_configured',
  'budget_exhausted',
  'empty_transcript',
  'provider_rejected',
  'provider_error',
  'audio_too_large',
  'unsupported_format',
  'draft_full',
  'interrupted',
  'transcript_discarded',
] as const
export type JournalRecordingFailureReason = (typeof JOURNAL_RECORDING_FAILURE_REASONS)[number]
export const JournalRecordingFailureReasonSchema = z.enum(JOURNAL_RECORDING_FAILURE_REASONS)

/** Owner-facing explanation. Never includes provider error text or audio content. */
export function journalFailureMessage(reason: string | null | undefined, mimeType?: string | null): string {
  switch (reason) {
    case 'not_configured':
      return 'Transcription is not set up yet, so this recording was not transcribed. You can type your entry instead.'
    case 'budget_exhausted':
      return "This month's AI budget is used up, so transcription is paused. Retry next month or type your entry."
    case 'empty_transcript':
      return 'The transcription came back empty. Retry, or type your entry.'
    case 'provider_rejected':
      return mimeType && journalIsUnverifiedTranscriptionFormat(mimeType)
        ? 'The transcription service did not accept this iPhone recording format (audio/mp4). Download it, or type your entry.'
        : 'The transcription service did not accept this recording. Retry, download it, or type your entry.'
    case 'provider_error':
      return 'The transcription service could not be reached or failed. Retry in a moment.'
    case 'audio_too_large':
      return 'This recording is too large to transcribe in one request. Download it, or type your entry.'
    case 'unsupported_format':
      return 'This recording format cannot be transcribed. Download it, or type your entry.'
    case 'draft_full':
      return 'There is already a long transcript waiting. Save or discard it, then retry.'
    case 'interrupted':
      return 'Transcription was interrupted. Retry.'
    case 'transcript_discarded':
      return 'You discarded the transcript. Retry, download or delete the recording.'
    default:
      return 'Transcription did not finish. Retry, download or delete the recording.'
  }
}

/** Failures worth an automatic "Retry" suggestion (vs. ones that need setup or a new month). */
export function journalFailureIsRetryable(reason: string | null | undefined): boolean {
  return reason !== 'unsupported_format' && reason !== 'audio_too_large'
}

export function journalRecordingExpiresAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + JOURNAL_RECORDING_RETENTION_DAYS * 86_400_000)
}

export function journalTranscriptionIsStale(transcribingSince: Date | string | null, now: Date): boolean {
  if (transcribingSince === null) return false
  const t = typeof transcribingSince === 'string' ? Date.parse(transcribingSince) : transcribingSince.getTime()
  return Number.isFinite(t) && now.getTime() - t >= JOURNAL_TRANSCRIPTION_STALE_MS
}

/** A recording as the UI sees it. No audio, no transcript text. */
export interface JournalRecordingView {
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
  failureReason: JournalRecordingFailureReason | null
  attempts: number
  createdAt: string
  expiresAt: string
  transcribingSince: string | null
}

/** What a transcription attempt ended with (returned to the UI after complete/retry). */
export type JournalTranscriptionResult =
  | { status: 'transcribed'; recording: JournalRecordingView }
  | { status: 'failed'; reason: JournalRecordingFailureReason; recording: JournalRecordingView }
  /** Another attempt holds the recording right now. */
  | { status: 'in_progress'; recording: JournalRecordingView }
  /** Upload not complete: these chunks are still missing. */
  | { status: 'incomplete'; missing: number[]; recording: JournalRecordingView }
  /** Nothing to do (already transcribed, or not in a retryable state). */
  | { status: 'not_retryable'; recording: JournalRecordingView }
  /** The recording was deleted (by the owner or by retention) before the attempt finished. */
  | { status: 'deleted' }
  | { status: 'not_found' }
