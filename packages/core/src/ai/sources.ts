/**
 * Which kinds of data may enter a model prompt. This is an allow-list: anything not listed,
 * including the explicitly forbidden Spotify and market-quote data (brief §5, §10), is refused.
 * The AI gateway checks it before a prompt is built, and the prompt builder checks it again for
 * every evidence item.
 */
import { z } from 'zod'

export const AI_SOURCE_TYPES = [
  'email',
  'calendar',
  'task',
  'habit',
  'plan',
  'reminder',
  'note',
  'journal',
  /** Recorded journal audio sent for transcription. */
  'journal_recording',
  'project_capture',
  'news_feed',
  'bank_transaction',
  'subscription',
  'health',
  'reading',
  'person',
  'briefing',
  /** A question the owner typed into dashboard chat. */
  'owner_question',
] as const
export const AiSourceTypeSchema = z.enum(AI_SOURCE_TYPES)
export type AiSourceType = z.infer<typeof AiSourceTypeSchema>

/**
 * Never sent to a model. Spotify content/metadata/artwork (Spotify developer terms and the
 * brief) and embedded market quote data (widget/data-licence terms). Listed separately so the
 * refusal is explicit and the database can enforce the same rule.
 */
export const AI_FORBIDDEN_SOURCE_TYPES = ['spotify', 'market_quote'] as const
export type AiForbiddenSourceType = (typeof AI_FORBIDDEN_SOURCE_TYPES)[number]

const ALLOWED: ReadonlySet<string> = new Set(AI_SOURCE_TYPES)

export class AiSourcePolicyError extends Error {
  override name = 'AiSourcePolicyError'
  /** The refused source types (sanitised for display; never content). */
  readonly rejected: readonly string[]
  constructor(rejected: readonly string[]) {
    super(`AI source policy refused: ${rejected.join(', ')}`)
    this.rejected = rejected
  }
}

export function isAiSourceAllowed(type: unknown): type is AiSourceType {
  return typeof type === 'string' && ALLOWED.has(type)
}

function describe(value: unknown): string {
  if (typeof value !== 'string') return `<${value === null ? 'null' : typeof value}>`
  const cleaned = value.replace(/[^\w.:-]/g, '?')
  return cleaned.length > 40 ? `${cleaned.slice(0, 40)}…` : cleaned || '<empty>'
}

/**
 * Throws AiSourcePolicyError unless every entry is an allowed source type. Call this before any
 * prompt text is assembled.
 */
export function assertAiSourcesAllowed(
  sources: readonly unknown[] | null | undefined,
): asserts sources is readonly AiSourceType[] {
  if (!Array.isArray(sources)) throw new AiSourcePolicyError(['<missing source list>'])
  const rejected = sources.filter((s) => !isAiSourceAllowed(s)).map(describe)
  if (rejected.length > 0) throw new AiSourcePolicyError([...new Set(rejected)])
}

/** Why a model call is made; recorded on every usage row and shown in Settings. */
export const AI_PURPOSES = [
  'extraction',
  'summary',
  'explanation',
  'chat',
  'briefing.morning',
  'briefing.evening',
  'project_review',
  'plan_draft',
  'transcription',
] as const
export const AiPurposeSchema = z.enum(AI_PURPOSES)
export type AiPurpose = z.infer<typeof AiPurposeSchema>
