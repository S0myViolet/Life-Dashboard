/**
 * Transcribe one uploaded journal recording.
 *
 *   1. claim the recording in a short transaction (fenced attempt, assembled audio);
 *   2. call the transcriber outside any transaction, bounded by a timeout;
 *   3. record the outcome in a second short transaction — a transcript goes to the entry's review
 *      draft (never straight into the entry), a failure keeps the recording for retry until it
 *      expires.
 *
 * Runs with an owner transaction in the web app (RLS enforced) or a service transaction in a job.
 * Nothing here logs; journal audio and text never leave the transcriber call and the database.
 */
import type { JournalTranscriptionResult } from '@personal-home/core'
import {
  beginJournalTranscription,
  finishJournalTranscription,
  type JournalTranscriptionOutcome,
  type Tx,
} from '@personal-home/db'
import { journalFailureReasonOf, type JournalTranscriber, type JournalTranscriberOutcome } from './transcriber.ts'

/** Runs `fn` in one transaction: withOwner(db, claims, fn) or withService(db, fn). */
export type JournalTxRunner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>

export interface TranscribeJournalRecordingDeps {
  run: JournalTxRunner
  transcriber: JournalTranscriber
  now?: () => Date
  /** Aborts the transcriber call (e.g. the request was cancelled). */
  signal?: AbortSignal
  /** Upper bound for one transcriber call. Default 240 s, inside a 300 s function limit. */
  timeoutMs?: number
}

export const JOURNAL_TRANSCRIBE_DEFAULT_TIMEOUT_MS = 240_000

class TranscriberTimeout extends Error {}

async function callTranscriber(
  deps: TranscribeJournalRecordingDeps,
  audio: Parameters<JournalTranscriber>[0],
): Promise<JournalTranscriberOutcome> {
  const controller = new AbortController()
  const onAbort = () => controller.abort(deps.signal?.reason)
  deps.signal?.addEventListener('abort', onAbort, { once: true })
  if (deps.signal?.aborted) controller.abort(deps.signal.reason)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new TranscriberTimeout())
      reject(new TranscriberTimeout())
    }, deps.timeoutMs ?? JOURNAL_TRANSCRIBE_DEFAULT_TIMEOUT_MS)
  })
  try {
    const running = Promise.resolve().then(() => deps.transcriber(audio, controller.signal))
    running.catch(() => {})
    return await Promise.race([running, timeout])
  } catch (err) {
    if (err instanceof TranscriberTimeout || controller.signal.aborted) return { status: 'failed', reason: 'interrupted' }
    return { status: 'failed', reason: 'provider_error' }
  } finally {
    clearTimeout(timer)
    deps.signal?.removeEventListener('abort', onAbort)
  }
}

function toStoredOutcome(outcome: JournalTranscriberOutcome): JournalTranscriptionOutcome {
  if (outcome.status === 'ok' && typeof outcome.text === 'string' && outcome.text.trim() !== '') {
    return { kind: 'transcript', text: outcome.text }
  }
  return { kind: 'failure', reason: journalFailureReasonOf(outcome) }
}

export async function transcribeJournalRecording(
  deps: TranscribeJournalRecordingDeps,
  recordingId: string,
): Promise<JournalTranscriptionResult> {
  const now = deps.now ?? (() => new Date())
  const claim = await deps.run((tx) => beginJournalTranscription(tx, recordingId, now()))
  switch (claim.status) {
    case 'not_found':
      return { status: 'not_found' }
    case 'in_progress':
      return { status: 'in_progress', recording: claim.recording }
    case 'incomplete':
      return { status: 'incomplete', missing: claim.missing, recording: claim.recording }
    case 'not_retryable':
      return { status: 'not_retryable', recording: claim.recording }
    case 'claimed':
      break
  }

  const outcome = await callTranscriber(deps, {
    bytes: claim.audio,
    mimeType: claim.recording.mimeType,
    durationSeconds: claim.recording.durationSeconds,
  })

  const finished = await deps.run((tx) =>
    finishJournalTranscription(
      tx,
      { id: recordingId, attempt: claim.attempt, outcome: toStoredOutcome(outcome) },
      now(),
    ),
  )
  switch (finished.status) {
    case 'transcribed':
      return { status: 'transcribed', recording: finished.recording }
    case 'failed':
      return { status: 'failed', reason: finished.reason, recording: finished.recording }
    case 'deleted':
      return { status: 'deleted' }
    case 'superseded': {
      // A newer attempt took over; report the recording as it is now (this result was dropped).
      const current = finished.recording
      if (current.status === 'transcribed') return { status: 'transcribed', recording: current }
      if (current.status === 'failed') {
        return { status: 'failed', reason: current.failureReason ?? 'provider_error', recording: current }
      }
      return { status: 'in_progress', recording: current }
    }
  }
}
