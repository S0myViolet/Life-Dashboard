/**
 * The seam between journal recordings and the AI gateway.
 *
 * A `JournalTranscriber` turns one recording's audio into text or an honest failure. The default
 * (`notConfiguredJournalTranscriber`) reports `not_configured`, which keeps the recording for retry
 * and leaves the owner free to type: the true state while no AI gateway is wired in.
 *
 * `createGatewayJournalTranscriber` adapts the gateway's runAiTranscription (m0/ai:
 * packages/jobs/src/ai/gateway.ts) without importing it, so this area builds on its own. Wiring:
 *
 *   createGatewayJournalTranscriber(({ audio, mimeType, audioSeconds }) =>
 *     runAiTranscription({ db, fetch, now, timezone, apiKey, audio, mimeType, audioSeconds }))
 *
 * The gateway reserves budget before any call (`budget_exhausted` means nothing was sent), sends
 * iPhone audio/mp4 relabelled as audio/m4a (unverified against the live API) and reports HTTP 200
 * with no transcript as `empty` — which becomes a failure here, never an empty entry.
 */
import { JOURNAL_RECORDING_FAILURE_REASONS, type JournalRecordingFailureReason } from '@personal-home/core'

export interface JournalTranscriberAudio {
  bytes: Uint8Array
  /** As recorded, e.g. 'audio/webm;codecs=opus' (desktop Chrome) or 'audio/mp4' (iPhone Safari). */
  mimeType: string
  /** Duration measured by the recorder, when known. */
  durationSeconds: number | null
}

export type JournalTranscriberOutcome =
  | { status: 'ok'; text: string }
  | {
      status: 'budget_exhausted' | 'not_configured' | 'failed'
      /**
       * For 'failed', one of JOURNAL_RECORDING_FAILURE_REASONS when it applies (anything else is
       * shown as a provider error). Codes only — never provider error text.
       */
      reason: string
    }

export type JournalTranscriber = (
  audio: JournalTranscriberAudio,
  signal: AbortSignal,
) => Promise<JournalTranscriberOutcome>

/** No AI configured: keep the recording (retry later) and let the owner type. */
export const notConfiguredJournalTranscriber: JournalTranscriber = async () => ({
  status: 'not_configured',
  reason: 'no_transcriber',
})

const REASONS: ReadonlySet<string> = new Set(JOURNAL_RECORDING_FAILURE_REASONS)

/** Map a transcriber outcome that is not a usable transcript to the stored failure reason. */
export function journalFailureReasonOf(outcome: JournalTranscriberOutcome): JournalRecordingFailureReason {
  switch (outcome.status) {
    case 'ok':
      return 'empty_transcript'
    case 'budget_exhausted':
      return 'budget_exhausted'
    case 'not_configured':
      return 'not_configured'
    case 'failed':
      return REASONS.has(outcome.reason) ? (outcome.reason as JournalRecordingFailureReason) : 'provider_error'
  }
}

// ---------------------------------------------------------------------------
// Gateway adapter (structural types mirror AiTranscriptionResult on m0/ai)
// ---------------------------------------------------------------------------

export interface JournalGatewayTranscriptionRequest {
  audio: Uint8Array
  mimeType: string
  /** Recorder duration; the gateway also derives an upper bound from the byte size. */
  audioSeconds: number
}

export type JournalGatewayTranscriptionResult =
  | { status: 'ok'; transcript: string; empty: boolean }
  | { status: 'budget_exhausted' }
  | { status: 'disabled'; reason: string }
  | { status: 'failed'; outcome: string; code: string }

/** Gateway/client failure code → journal failure reason. */
export function journalFailureReasonFromGatewayCode(code: string): JournalRecordingFailureReason | 'not_configured' {
  if (code === 'audio_too_large' || code === 'input_too_large') return 'audio_too_large'
  if (code === 'unsupported_audio_type') return 'unsupported_format'
  if (code === 'missing_api_key') return 'not_configured'
  const http = /^http_(\d{3})$/.exec(code)
  if (http) {
    const status = Number(http[1])
    // 4xx means the provider refused this request (e.g. an audio format it does not accept);
    // 408/429 are transient.
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) return 'provider_rejected'
  }
  return 'provider_error'
}

export function createGatewayJournalTranscriber(
  run: (request: JournalGatewayTranscriptionRequest) => Promise<JournalGatewayTranscriptionResult>,
): JournalTranscriber {
  return async (audio, signal) => {
    if (signal.aborted) return { status: 'failed', reason: 'interrupted' }
    let result: JournalGatewayTranscriptionResult
    try {
      result = await run({
        audio: audio.bytes,
        mimeType: audio.mimeType,
        audioSeconds: audio.durationSeconds ?? 0,
      })
    } catch {
      // Invalid input or an unexpected gateway error: report it without its message.
      return { status: 'failed', reason: 'provider_error' }
    }
    switch (result.status) {
      case 'ok':
        return result.empty || result.transcript.trim() === ''
          ? { status: 'failed', reason: 'empty_transcript' }
          : { status: 'ok', text: result.transcript }
      case 'budget_exhausted':
        return { status: 'budget_exhausted', reason: 'budget_exhausted' }
      case 'disabled':
        return { status: 'not_configured', reason: result.reason }
      case 'failed': {
        const reason = journalFailureReasonFromGatewayCode(result.code)
        return reason === 'not_configured'
          ? { status: 'not_configured', reason: result.code }
          : { status: 'failed', reason }
      }
      default:
        return { status: 'failed', reason: 'provider_error' }
    }
  }
}
