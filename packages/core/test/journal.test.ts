import { describe, expect, it } from 'vitest'
import {
  JOURNAL_CHUNK_BYTES,
  JOURNAL_PROMPTS,
  JOURNAL_RECORDING_MAX_SECONDS,
  JournalEntryContentSchema,
  JournalRecordingCreateSchema,
  journalAppendText,
  journalChunkCount,
  journalChunkRange,
  journalChunkSize,
  journalContentEqual,
  journalContentFields,
  journalContentFromFields,
  journalExcerpt,
  journalFailureMessage,
  journalMissingChunks,
  journalNormalizeRecordedMime,
  journalPickRecorderMimeType,
  journalRecordingExpiresAt,
  journalRecordingFileExtension,
  journalTranscriptionIsStale,
} from '../src/index.ts'

describe('recorder MIME selection', () => {
  const supports = (types: string[]) => (t: string) => types.includes(t)

  it('prefers WebM/Opus (desktop Chrome)', () => {
    expect(journalPickRecorderMimeType(supports(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']))).toBe(
      'audio/webm;codecs=opus',
    )
  })

  it('falls back to MP4/AAC (iPhone Safari before WebM support)', () => {
    expect(journalPickRecorderMimeType(supports(['audio/mp4']))).toBe('audio/mp4')
    expect(journalPickRecorderMimeType(supports(['audio/mp4;codecs=mp4a.40.2', 'audio/mp4']))).toBe(
      'audio/mp4;codecs=mp4a.40.2',
    )
  })

  it('returns null when support cannot be asked or nothing matches (browser default is used)', () => {
    expect(journalPickRecorderMimeType(undefined)).toBeNull()
    expect(journalPickRecorderMimeType(supports([]))).toBeNull()
    expect(
      journalPickRecorderMimeType(() => {
        throw new Error('boom')
      }),
    ).toBeNull()
  })

  it('normalises what the recorder reported, relabelling audio-only video/* and rejecting non-audio', () => {
    expect(journalNormalizeRecordedMime('audio/webm;codecs=opus')).toBe('audio/webm;codecs=opus')
    expect(journalNormalizeRecordedMime('audio/ogg; codecs=opus')).toBe('audio/ogg;codecs=opus')
    expect(journalNormalizeRecordedMime('video/webm;codecs=opus')).toBe('audio/webm;codecs=opus')
    expect(journalNormalizeRecordedMime('', 'audio/mp4')).toBe('audio/mp4')
    expect(journalNormalizeRecordedMime('video/x-matroska', 'text/html')).toBeNull()
    expect(journalNormalizeRecordedMime('audio/webm;codecs=opus<script>')).toBeNull()
  })

  it('names downloads by format', () => {
    expect(journalRecordingFileExtension('audio/webm;codecs=opus')).toBe('webm')
    expect(journalRecordingFileExtension('audio/mp4')).toBe('m4a')
    expect(journalRecordingFileExtension('audio/ogg')).toBe('ogg')
  })
})

describe('chunk plan', () => {
  it('slices a recording into fixed-size chunks with a short last chunk', () => {
    const size = 2 * JOURNAL_CHUNK_BYTES + 5
    expect(journalChunkCount(size, JOURNAL_CHUNK_BYTES)).toBe(3)
    expect(journalChunkSize(size, JOURNAL_CHUNK_BYTES, 0)).toBe(JOURNAL_CHUNK_BYTES)
    expect(journalChunkSize(size, JOURNAL_CHUNK_BYTES, 2)).toBe(5)
    expect(journalChunkSize(size, JOURNAL_CHUNK_BYTES, 3)).toBeNull()
    expect(journalChunkSize(size, JOURNAL_CHUNK_BYTES, -1)).toBeNull()
    expect(journalChunkRange(size, JOURNAL_CHUNK_BYTES, 2)).toEqual([2 * JOURNAL_CHUNK_BYTES, size])
    expect(journalChunkCount(JOURNAL_CHUNK_BYTES, JOURNAL_CHUNK_BYTES)).toBe(1)
  })

  it('lists missing chunks for a resumed upload', () => {
    expect(journalMissingChunks(5, [0, 2, 2, 4])).toEqual([1, 3])
    expect(journalMissingChunks(2, [0, 1])).toEqual([])
  })

  it('validates a new recording (size, chunking, format, duration)', () => {
    const ok = {
      id: crypto.randomUUID(),
      localDate: '2026-09-24',
      mimeType: 'audio/webm;codecs=opus',
      byteSize: 1234,
      chunkBytes: JOURNAL_CHUNK_BYTES,
      durationSeconds: 3.2,
    }
    expect(JournalRecordingCreateSchema.safeParse(ok).success).toBe(true)
    expect(JournalRecordingCreateSchema.safeParse({ ...ok, byteSize: 0 }).success).toBe(false)
    expect(JournalRecordingCreateSchema.safeParse({ ...ok, byteSize: 26_214_401 }).success).toBe(false)
    expect(JournalRecordingCreateSchema.safeParse({ ...ok, chunkBytes: 2_000_000 }).success).toBe(false)
    expect(JournalRecordingCreateSchema.safeParse({ ...ok, chunkBytes: 65_536, byteSize: 65_536 * 65 }).success).toBe(
      false,
    )
    expect(JournalRecordingCreateSchema.safeParse({ ...ok, mimeType: 'video/mp4' }).success).toBe(false)
    expect(JournalRecordingCreateSchema.safeParse({ ...ok, durationSeconds: 4000 }).success).toBe(false)
    expect(JOURNAL_RECORDING_MAX_SECONDS).toBe(900)
  })
})

describe('retention and staleness', () => {
  it('expires a recording exactly seven days after it was made', () => {
    const created = new Date('2026-09-24T10:00:00Z')
    expect(journalRecordingExpiresAt(created).toISOString()).toBe('2026-10-01T10:00:00.000Z')
  })

  it('treats a transcription attempt older than ten minutes as interrupted', () => {
    const since = new Date('2026-09-24T10:00:00Z')
    expect(journalTranscriptionIsStale(since, new Date('2026-09-24T10:09:59Z'))).toBe(false)
    expect(journalTranscriptionIsStale(since.toISOString(), new Date('2026-09-24T10:10:00Z'))).toBe(true)
    expect(journalTranscriptionIsStale(null, new Date())).toBe(false)
  })

  it('explains failures without provider text, and flags the unverified iPhone format', () => {
    expect(journalFailureMessage('not_configured')).toMatch(/not set up/)
    expect(journalFailureMessage('budget_exhausted')).toMatch(/budget/)
    expect(journalFailureMessage('provider_rejected', 'audio/mp4')).toMatch(/iPhone recording format/)
    expect(journalFailureMessage('provider_rejected', 'audio/webm')).not.toMatch(/iPhone/)
    expect(journalFailureMessage('something_else')).toMatch(/Retry/)
  })
})

describe('journal entry content', () => {
  it('has the four optional prompts and no mood field', () => {
    expect(JOURNAL_PROMPTS.map((p) => p.label)).toEqual([
      'What happened',
      'What moved forward',
      'What needs attention',
      'What to do next',
    ])
    expect(JournalEntryContentSchema.safeParse({ body: '', prompts: { mood: 'good' } }).success).toBe(false)
    expect(JournalEntryContentSchema.safeParse({ body: '', prompts: {}, mood: 3 }).data).toEqual({
      body: '',
      prompts: {},
    })
  })

  it('drops blank prompt answers so "unanswered" has one representation', () => {
    const c = JournalEntryContentSchema.parse({ body: 'x', prompts: { what_happened: '  ', next: 'Call Sam' } })
    expect(c.prompts).toEqual({ next: 'Call Sam' })
    expect(journalContentEqual(c, { body: 'x', prompts: { next: 'Call Sam' } })).toBe(true)
    expect(journalContentFromFields(journalContentFields(c))).toEqual(c)
  })

  it('appends reviewed transcripts after typed text with a blank line', () => {
    expect(journalAppendText('', ' hello ')).toBe('hello')
    expect(journalAppendText('typed\n\n', 'spoken')).toBe('typed\n\nspoken')
    expect(journalAppendText(null, 'x')).toBe('x')
    expect(journalAppendText('typed', '   ')).toBe('typed')
  })

  it('excerpts the body, else the first answered prompt', () => {
    expect(journalExcerpt({ body: 'a\n\nb', prompts: {} })).toBe('a b')
    expect(journalExcerpt({ body: ' ', prompts: { moved_forward: 'Shipped it' } })).toBe('Shipped it')
  })
})
