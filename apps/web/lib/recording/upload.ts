/**
 * Resumable, idempotent upload of one journal recording to /api/journal/recordings in ≤1 MB
 * chunks (Vercel request limits), then "complete", which also asks for the transcription.
 *
 *   1. POST   /api/journal/recordings                  register (device id → idempotent)
 *   2. PUT    /api/journal/recordings/:id/chunks/:seq  only the chunks the server lacks
 *   3. POST   /api/journal/recordings/:id/complete     verify + transcribe
 *
 * Any step can be repeated safely; a retry after a dropped connection resumes from what the server
 * already has. Pure apart from the injected fetch, so it is unit-tested with a fake server.
 */
import {
  JOURNAL_CHUNK_BYTES,
  journalChunkRange,
  journalMissingChunks,
  type JournalRecordingView,
  type JournalTranscriptionResult,
} from '@personal-home/core'

export interface UploadableRecording {
  id: string
  localDate: string
  mimeType: string
  durationSeconds: number | null
  data: ArrayBuffer | Uint8Array
}

export type UploadPhase = 'registering' | 'uploading' | 'finishing'

export interface UploadDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>
  chunkBytes?: number
  onProgress?: (p: { phase: UploadPhase; sentChunks: number; totalChunks: number }) => void
  /** Attempts per request before giving up on this pass (network errors and 5xx only). */
  maxAttempts?: number
  sleep?: (ms: number) => Promise<void>
}

export type UploadFailureCode =
  | 'offline'
  | 'signed_out'
  | 'server_error'
  | 'rejected'
  | 'id_conflict'
  | 'mismatch'
  | 'expired'

export type UploadOutcome =
  /** The server has the whole recording; `result` is what happened to the transcription. */
  | { status: 'uploaded'; recording: JournalRecordingView | null; result: JournalTranscriptionResult | null }
  | { status: 'failed'; code: UploadFailureCode; retryable: boolean }

const RETRYABLE: ReadonlySet<UploadFailureCode> = new Set(['offline', 'server_error', 'signed_out'])

class StepFailure extends Error {
  constructor(readonly code: UploadFailureCode) {
    super(code)
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function request(
  deps: UploadDeps,
  url: string,
  init: RequestInit,
  classify: (res: Response) => UploadFailureCode | null,
): Promise<Response> {
  const attempts = Math.max(1, deps.maxAttempts ?? 3)
  const sleep = deps.sleep ?? defaultSleep
  let last: UploadFailureCode = 'offline'
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(500 * 2 ** (i - 1))
    let res: Response
    try {
      res = await deps.fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store' })
    } catch {
      last = 'offline'
      continue
    }
    if (res.status === 401) throw new StepFailure('signed_out')
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      last = 'server_error'
      continue
    }
    const failure = classify(res)
    if (failure) throw new StepFailure(failure)
    return res
  }
  throw new StepFailure(last)
}

async function json<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T
  } catch {
    return null
  }
}

function bytesOf(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data)
}

export async function uploadJournalRecording(rec: UploadableRecording, deps: UploadDeps): Promise<UploadOutcome> {
  const bytes = bytesOf(rec.data)
  const chunkBytes = deps.chunkBytes ?? JOURNAL_CHUNK_BYTES
  const base = `/api/journal/recordings`
  try {
    deps.onProgress?.({ phase: 'registering', sentChunks: 0, totalChunks: 0 })
    const created = await request(
      deps,
      base,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: rec.id,
          localDate: rec.localDate,
          mimeType: rec.mimeType,
          byteSize: bytes.byteLength,
          chunkBytes,
          durationSeconds: rec.durationSeconds,
        }),
      },
      (res) => (res.status === 409 ? 'id_conflict' : res.status === 400 ? 'rejected' : !res.ok ? 'rejected' : null),
    )
    let recording = (await json<{ recording: JournalRecordingView }>(created))?.recording ?? null
    if (!recording) throw new StepFailure('server_error')

    for (let pass = 0; pass < 2; pass++) {
      if (recording.status === 'uploading') {
        const missing = journalMissingChunks(recording.expectedChunks, recording.receivedChunks)
        const total = recording.expectedChunks
        let sent = total - missing.length
        deps.onProgress?.({ phase: 'uploading', sentChunks: sent, totalChunks: total })
        for (const seq of missing) {
          // Slice with the size the server registered, so a resumed upload always matches it.
          const [start, end] = journalChunkRange(bytes.byteLength, recording.chunkBytes, seq)
          const res = await request(
            deps,
            `${base}/${rec.id}/chunks/${seq}`,
            {
              method: 'PUT',
              headers: { 'content-type': 'application/octet-stream' },
              body: bytes.slice(start, end),
            },
            (r) => {
              if (r.status === 404) return 'expired'
              if (r.status === 409) return null // handled below (mismatch vs already complete)
              return r.ok ? null : 'rejected'
            },
          )
          if (res.status === 409) {
            const body = await json<{ error?: string }>(res)
            if (body?.error === 'not_uploading') break
            throw new StepFailure('mismatch')
          }
          sent++
          deps.onProgress?.({ phase: 'uploading', sentChunks: sent, totalChunks: total })
        }
      }

      deps.onProgress?.({ phase: 'finishing', sentChunks: recording.expectedChunks, totalChunks: recording.expectedChunks })
      const done = await request(deps, `${base}/${rec.id}/complete`, { method: 'POST' }, (r) =>
        r.status === 404 ? 'expired' : r.status === 409 ? null : r.ok ? null : 'rejected',
      )
      const body = await json<{
        error?: string
        missing?: number[]
        recording?: JournalRecordingView
        result?: JournalTranscriptionResult
      }>(done)
      if (done.status === 409 && body?.error === 'incomplete' && body.recording) {
        // The server lost or refused a chunk: send what it reports missing, once more.
        recording = body.recording
        continue
      }
      if (!done.ok) throw new StepFailure('server_error')
      return { status: 'uploaded', recording: body?.recording ?? null, result: body?.result ?? null }
    }
    throw new StepFailure('server_error')
  } catch (err) {
    const code = err instanceof StepFailure ? err.code : 'offline'
    return { status: 'failed', code, retryable: RETRYABLE.has(code) }
  }
}

export const UPLOAD_FAILURE_MESSAGES: Record<UploadFailureCode, string> = {
  offline: 'Upload paused: no connection. It is kept on this device and will retry.',
  signed_out: 'Upload paused: you are signed out. Sign in again; the recording is kept on this device.',
  server_error: 'Upload failed on the server. It is kept on this device; retry in a moment.',
  rejected: 'The server refused this recording (format or size). It is kept on this device; download it or type instead.',
  id_conflict: 'This recording clashed with another upload. Download it, then delete and record again.',
  mismatch: 'Part of this upload did not match what the server already has. Download it, then delete it and record again.',
  expired: 'The server copy of this upload has expired. Delete it, or download it from this device.',
}
