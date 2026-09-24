/**
 * Microphone/recorder failure vocabulary. Pure, so it is unit-tested; the messages always leave
 * typing as the way forward (brief §2: handle microphone denial).
 */

export type RecorderError = 'denied' | 'no_device' | 'busy' | 'unsupported' | 'insecure' | 'failed'

/** Classify a getUserMedia / MediaRecorder error by its DOMException name. */
export function recorderErrorOf(err: unknown): RecorderError {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'denied'
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'no_device'
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'busy'
    case 'NotSupportedError':
    case 'TypeError':
      return 'unsupported'
    default:
      return 'failed'
  }
}

export const RECORDER_ERROR_MESSAGES: Record<RecorderError, string> = {
  denied:
    'Microphone access is blocked for this site. To record, allow the microphone in your browser’s site settings. You can type your entry instead.',
  no_device: 'No microphone was found. You can type your entry instead.',
  busy: 'The microphone could not start (it may be in use by another app). Try again, or type your entry instead.',
  unsupported: 'This browser cannot record audio here. You can type your entry instead.',
  insecure: 'Recording needs a secure (https) connection. You can type your entry instead.',
  failed: 'Recording stopped unexpectedly. Try again, or type your entry instead.',
}

/** What this browser offers before asking for the microphone. */
export function recorderSupport(env: {
  isSecureContext?: boolean
  hasGetUserMedia: boolean
  hasMediaRecorder: boolean
}): RecorderError | null {
  if (env.isSecureContext === false) return 'insecure'
  if (!env.hasGetUserMedia || !env.hasMediaRecorder) return 'unsupported'
  return null
}

export function formatRecordingClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
