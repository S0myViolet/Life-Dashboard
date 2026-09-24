/**
 * Audio input rules for Gemini transcription (docs/research/gemini.md, 2026-09-24).
 */

/** MIME types the Developer API lists for audio input. */
export const GEMINI_AUDIO_MIME_TYPES = [
  'audio/wav',
  'audio/mp3',
  'audio/aiff',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'audio/mpeg',
  'audio/m4a',
  'audio/l16',
  'audio/opus',
  'audio/alaw',
  'audio/mulaw',
  'audio/webm',
] as const
export type GeminiAudioMimeType = (typeof GEMINI_AUDIO_MIME_TYPES)[number]

/**
 * Inline audio limit. The docs disagree (20 MB total request on the audio page, 100 MB on the
 * newer file-input page); base64 adds a third. 14,000,000 raw bytes → ~18.7 MB encoded keeps
 * the whole request under the stricter 20 MB figure. Larger recordings need the Files API,
 * which is not implemented yet.
 */
export const GEMINI_MAX_INLINE_AUDIO_BYTES = 14_000_000

const LISTED: ReadonlySet<string> = new Set(GEMINI_AUDIO_MIME_TYPES)

/**
 * Aliases mapped onto listed types. `verified: false` marks a relabel that the research could
 * not confirm against the live API.
 */
const ALIASES: Readonly<Record<string, { to: GeminiAudioMimeType; verified: boolean }>> = {
  'audio/x-wav': { to: 'audio/wav', verified: true },
  'audio/wave': { to: 'audio/wav', verified: true },
  'audio/vnd.wave': { to: 'audio/wav', verified: true },
  'audio/x-aiff': { to: 'audio/aiff', verified: true },
  'audio/x-aac': { to: 'audio/aac', verified: true },
  'audio/x-flac': { to: 'audio/flac', verified: true },
  'audio/mpga': { to: 'audio/mpeg', verified: true },
  'audio/x-m4a': { to: 'audio/m4a', verified: true },
  // Audio-only WebM is sometimes labelled video/webm; the API then returns an empty transcript.
  'video/webm': { to: 'audio/webm', verified: true },
  // iPhone Safari's MediaRecorder default (MP4 container, AAC). audio/mp4 is not on the
  // Developer API list; M4A is the same container family. Unverified until tested live.
  'audio/mp4': { to: 'audio/m4a', verified: false },
}

export interface GeminiAudioMime {
  mimeType: GeminiAudioMimeType
  /** The original type when it was relabelled. */
  relabelledFrom: string | null
  /** False when the relabel has not been confirmed against the live API. */
  verified: boolean
}

/**
 * Normalise a recorder/upload MIME type ('audio/webm;codecs=opus' → 'audio/webm'). Returns null
 * for types the API does not accept.
 */
export function normalizeGeminiAudioMimeType(raw: string): GeminiAudioMime | null {
  if (typeof raw !== 'string') return null
  const base = raw.split(';')[0]!.trim().toLowerCase()
  if (LISTED.has(base)) {
    return {
      mimeType: base as GeminiAudioMimeType,
      relabelledFrom: base === raw.trim().toLowerCase() ? null : raw.trim().slice(0, 100),
      verified: true,
    }
  }
  const alias = Object.hasOwn(ALIASES, base) ? ALIASES[base] : undefined
  if (!alias) return null
  return { mimeType: alias.to, relabelledFrom: raw.trim().slice(0, 100), verified: alias.verified }
}

/**
 * Output token allowance for a transcript. The pricing page estimates 175 output tokens per
 * minute; this allows ~3.5× that (fast speech, languages that tokenise densely) plus a margin.
 */
export function geminiTranscriptOutputTokenBudget(audioSeconds: number): number {
  if (!Number.isFinite(audioSeconds) || audioSeconds < 0) {
    throw new RangeError('audioSeconds must be a non-negative number')
  }
  return Math.min(65_536, Math.ceil((audioSeconds / 60) * 600) + 256)
}

/**
 * Upper bound on a recording's duration from its size, assuming nothing below 6 kbit/s (Opus'
 * floor; AAC/MP3 voice presets are higher). Used so a wrong client-reported duration cannot
 * shrink the budget reservation.
 */
export function geminiAudioSecondsUpperBound(byteLength: number): number {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new RangeError('byteLength must be a non-negative integer')
  }
  return Math.ceil((byteLength * 8) / 6_000)
}
