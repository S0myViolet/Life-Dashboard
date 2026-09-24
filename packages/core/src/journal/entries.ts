/**
 * Journal entries: one page per owner-local date, typed text plus optional prompts, and a
 * machine transcript draft that only becomes part of the entry when the owner saves it.
 * Deliberately no mood fields (brief §1, §2).
 */
import { z } from 'zod'
import { CalendarDateSchema } from '../time/index.ts'
import { notesStripNul } from '../notes/schemas.ts'

export const JOURNAL_BODY_MAX = 200_000
export const JOURNAL_PROMPT_MAX = 20_000

/** Optional prompts, in display order. Never required. */
export const JOURNAL_PROMPTS = [
  { key: 'what_happened', label: 'What happened' },
  { key: 'moved_forward', label: 'What moved forward' },
  { key: 'needs_attention', label: 'What needs attention' },
  { key: 'next', label: 'What to do next' },
] as const

export type JournalPromptKey = (typeof JOURNAL_PROMPTS)[number]['key']
export const JOURNAL_PROMPT_KEYS: readonly JournalPromptKey[] = JOURNAL_PROMPTS.map((p) => p.key)

const PromptText = z.string().max(JOURNAL_PROMPT_MAX)

/** Stored shape: only answered prompts are kept; blank answers are dropped. */
export const JournalPromptsSchema = z
  .object({
    what_happened: PromptText.optional(),
    moved_forward: PromptText.optional(),
    needs_attention: PromptText.optional(),
    next: PromptText.optional(),
  })
  .strict()
  .transform((p) => {
    const out: Partial<Record<JournalPromptKey, string>> = {}
    for (const key of JOURNAL_PROMPT_KEYS) {
      const v = p[key]
      if (typeof v === 'string') {
        const s = notesStripNul(v)
        if (s.trim() !== '') out[key] = s
      }
    }
    return out
  })
export type JournalPrompts = z.output<typeof JournalPromptsSchema>

export const JournalEntryContentSchema = z.object({
  body: z.string().max(JOURNAL_BODY_MAX).transform(notesStripNul),
  prompts: JournalPromptsSchema,
})
export type JournalEntryContent = z.output<typeof JournalEntryContentSchema>
export type JournalEntryContentInput = z.input<typeof JournalEntryContentSchema>

export const EMPTY_JOURNAL_CONTENT: JournalEntryContent = Object.freeze({ body: '', prompts: {} })

/**
 * A save of the typed part of an entry. Entries are addressed by local date; `baseVersion` 0
 * means the device has not seen an entry for that date yet.
 */
export const JournalEntrySaveInputSchema = z.object({
  localDate: CalendarDateSchema,
  baseVersion: z.number().int().min(0).max(2_147_483_647),
  content: JournalEntryContentSchema,
})
export type JournalEntrySaveInput = z.input<typeof JournalEntrySaveInputSchema>

export const JOURNAL_ORIGINS = ['typed', 'voice'] as const
export type JournalOrigin = (typeof JOURNAL_ORIGINS)[number]

export const JOURNAL_TRANSCRIPT_STATUSES = [
  'pending',
  'transcribing',
  'ready_for_review',
  'saved',
  'failed',
  'unavailable',
] as const
export type JournalTranscriptStatus = (typeof JOURNAL_TRANSCRIPT_STATUSES)[number]

export interface JournalEntryView {
  id: string
  localDate: string
  body: string
  prompts: JournalPrompts
  origin: JournalOrigin
  transcriptStatus: JournalTranscriptStatus | null
  /** Transcript waiting for review; null when there is none. */
  transcriptDraft: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export type JournalEntrySaveResult =
  | { status: 'saved'; entry: JournalEntryView }
  | { status: 'conflict'; server: JournalEntryView }
  | { status: 'invalid'; issues: string[] }
  | { status: 'unauthorized' }
  | { status: 'error'; code: string }

export function journalNormalizeContent(content: JournalEntryContentInput): JournalEntryContent {
  return JournalEntryContentSchema.parse(content)
}

export function journalContentEqual(a: JournalEntryContent, b: JournalEntryContent): boolean {
  if (a.body !== b.body) return false
  for (const key of JOURNAL_PROMPT_KEYS) if ((a.prompts[key] ?? '') !== (b.prompts[key] ?? '')) return false
  return true
}

/** Flatten for field-level merging (see notesMergeRecords). */
export function journalContentFields(c: JournalEntryContent): Record<'body' | JournalPromptKey, string> {
  return {
    body: c.body,
    what_happened: c.prompts.what_happened ?? '',
    moved_forward: c.prompts.moved_forward ?? '',
    needs_attention: c.prompts.needs_attention ?? '',
    next: c.prompts.next ?? '',
  }
}

export function journalContentFromFields(f: Record<'body' | JournalPromptKey, string>): JournalEntryContent {
  return journalNormalizeContent({
    body: f.body,
    prompts: {
      what_happened: f.what_happened,
      moved_forward: f.moved_forward,
      needs_attention: f.needs_attention,
      next: f.next,
    },
  })
}

export const JOURNAL_TEXT_FIELDS = ['body', ...JOURNAL_PROMPT_KEYS] as const

/** Append a block of text after existing text, separated by a blank line. */
export function journalAppendText(existing: string | null | undefined, addition: string): string {
  const head = (existing ?? '').replace(/\s+$/, '')
  const tail = addition.replace(/^\s+/, '').replace(/\s+$/, '')
  if (head === '') return tail
  if (tail === '') return head
  return `${head}\n\n${tail}`
}

export const JournalTranscriptSaveInputSchema = z.object({
  localDate: CalendarDateSchema,
  /** The entry version the device's text is based on (after flushing its own typing). */
  baseVersion: z.number().int().min(1).max(2_147_483_647),
  /** The transcript draft exactly as the device displayed it before the owner edited it. */
  draftSeen: z.string().max(JOURNAL_BODY_MAX),
  /** The owner-reviewed transcript to add to the entry. */
  text: z.string().max(JOURNAL_BODY_MAX).transform(notesStripNul),
})
export type JournalTranscriptSaveInput = z.input<typeof JournalTranscriptSaveInputSchema>

export const JournalTranscriptDiscardInputSchema = z.object({
  localDate: CalendarDateSchema,
  draftSeen: z.string().max(JOURNAL_BODY_MAX),
})
export type JournalTranscriptDiscardInput = z.input<typeof JournalTranscriptDiscardInputSchema>

export type JournalTranscriptSaveResult =
  | { status: 'saved'; entry: JournalEntryView; recordingsDeleted: number }
  /** Another transcript arrived (or it was reviewed elsewhere); `entry.transcriptDraft` is current. */
  | { status: 'draft_changed'; entry: JournalEntryView }
  /** The typed text moved on; flush and reload before adding the transcript. */
  | { status: 'conflict'; entry: JournalEntryView }
  | { status: 'too_long' }
  | { status: 'not_found' }
  | { status: 'invalid'; issues: string[] }
  | { status: 'unauthorized' }
  | { status: 'error'; code: string }

export function journalExcerpt(entry: Pick<JournalEntryView, 'body' | 'prompts'>, max = 160): string {
  const source =
    entry.body.trim() !== ''
      ? entry.body
      : (JOURNAL_PROMPT_KEYS.map((k) => entry.prompts[k]).find((v) => v && v.trim() !== '') ?? '')
  const flat = source.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
