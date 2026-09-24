/**
 * Lenient parsing of generateContent responses. Unknown or malformed fields are dropped rather
 * than failing the whole response, so usage can still be reconciled when text is missing.
 */
import { z } from 'zod'
import type { AiTokenUsage } from '@personal-home/core'

const Count = z.number().int().nonnegative().optional().catch(undefined)
const Str = z.string().optional().catch(undefined)

const ModalityCountSchema = z.object({ modality: Str, tokenCount: Count })

export const GeminiUsageMetadataSchema = z.object({
  promptTokenCount: Count,
  candidatesTokenCount: Count,
  thoughtsTokenCount: Count,
  totalTokenCount: Count,
  cachedContentTokenCount: Count,
  toolUsePromptTokenCount: Count,
  promptTokensDetails: z.array(ModalityCountSchema).optional().catch(undefined),
  candidatesTokensDetails: z.array(ModalityCountSchema).optional().catch(undefined),
})
export type GeminiUsageMetadata = z.infer<typeof GeminiUsageMetadataSchema>

const PartSchema = z.object({
  text: Str,
  thought: z.boolean().optional().catch(undefined),
  audioTranscription: z.object({ text: Str, speakerLabel: Str }).optional().catch(undefined),
})

const CandidateSchema = z.object({
  content: z
    .object({ parts: z.array(PartSchema).optional().catch(undefined) })
    .optional()
    .catch(undefined),
  finishReason: Str,
})

export const GeminiGenerateResponseSchema = z.object({
  candidates: z.array(CandidateSchema).optional().catch(undefined),
  promptFeedback: z.object({ blockReason: Str }).optional().catch(undefined),
  usageMetadata: GeminiUsageMetadataSchema.optional().catch(undefined),
  modelVersion: Str,
  responseId: Str,
})
export type GeminiGenerateResponse = z.infer<typeof GeminiGenerateResponseSchema>

/** Map usageMetadata onto the provider-neutral usage shape used for cost reconciliation. */
export function geminiUsageFromMetadata(meta: GeminiUsageMetadata | undefined): AiTokenUsage | null {
  if (!meta) return null
  const details = meta.promptTokensDetails
  const audio = details
    ? details
        .filter((d) => d.modality === 'AUDIO')
        .reduce((sum, d) => sum + (d.tokenCount ?? 0), 0)
    : null
  const usage: AiTokenUsage = {
    promptTokens: meta.promptTokenCount ?? null,
    promptAudioTokens: audio,
    candidatesTokens: meta.candidatesTokenCount ?? null,
    thoughtsTokens: meta.thoughtsTokenCount ?? null,
    toolUsePromptTokens: meta.toolUsePromptTokenCount ?? null,
    cachedTokens: meta.cachedContentTokenCount ?? null,
    totalTokens: meta.totalTokenCount ?? null,
  }
  const reported =
    usage.promptTokens != null ||
    usage.candidatesTokens != null ||
    usage.thoughtsTokens != null ||
    usage.totalTokens != null
  return reported ? usage : null
}

/** Answer text of the first candidate, excluding thought summaries. */
export function geminiResponseText(res: GeminiGenerateResponse): string {
  const parts = res.candidates?.[0]?.content?.parts ?? []
  return parts
    .filter((p) => p.thought !== true && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
}

/**
 * Transcript of the first candidate. gemini-3.5-transcribe returns it in
 * parts[].audioTranscription.text, not parts[].text; fall back to text parts for other models.
 *
 * The research does not say whether a non-streaming response splits the transcript into several
 * parts (it documents per-utterance fields such as speakerLabel), so segments are joined with a
 * space unless one is already present, and with a line break where the speaker changes.
 */
export function geminiResponseTranscript(res: GeminiGenerateResponse): string {
  const parts = res.candidates?.[0]?.content?.parts ?? []
  const segments = parts
    .map((p) => p.audioTranscription)
    .filter((t): t is { text: string; speakerLabel?: string } => typeof t?.text === 'string')
  if (segments.length === 0) return geminiResponseText(res)
  let out = ''
  let speaker: string | undefined
  for (const seg of segments) {
    if (seg.text === '') continue
    if (out !== '') {
      const speakerChanged =
        seg.speakerLabel !== undefined && speaker !== undefined && seg.speakerLabel !== speaker
      if (speakerChanged) out = `${out.trimEnd()}\n${seg.text.trimStart()}`
      else out += /\s$/.test(out) || /^\s/.test(seg.text) ? seg.text : ` ${seg.text}`
    } else {
      out = seg.text
    }
    if (seg.speakerLabel !== undefined) speaker = seg.speakerLabel
  }
  return out
}
