/**
 * public.journal_entries access: one entry per owner-local date (unique index), typed text and
 * optional prompts under optimistic concurrency, and the transcript draft review flow.
 *
 * Journal text is never logged and never leaves these functions except to the owner's UI.
 */
import {
  CalendarDateSchema,
  JOURNAL_BODY_MAX,
  JournalEntrySaveInputSchema,
  JournalPromptsSchema,
  JournalTranscriptDiscardInputSchema,
  JournalTranscriptSaveInputSchema,
  NOTES_HIGHLIGHT_START,
  NOTES_HIGHLIGHT_STOP,
  journalAppendText,
  journalContentEqual,
  notesSearchTsQuery,
  notesZodIssues,
  type JournalEntrySaveInput,
  type JournalEntrySaveResult,
  type JournalEntryView,
  type JournalOrigin,
  type JournalPrompts,
  type JournalTranscriptDiscardInput,
  type JournalTranscriptSaveInput,
  type JournalTranscriptSaveResult,
  type JournalTranscriptStatus,
} from '@personal-home/core'
import type postgres from 'postgres'
import type { Tx } from '../client.ts'

interface EntryDbRow {
  id: string
  localDate: string
  body: string
  prompts: unknown
  origin: JournalOrigin
  transcriptStatus: JournalTranscriptStatus | null
  transcriptDraft: string | null
  version: number
  createdAt: Date
  updatedAt: Date
}

/**
 * Prompts are selected as text (`prompts::text`): the client's camelCase transform would otherwise
 * rewrite the snake_case JSON keys ('moved_forward' → 'movedForward').
 */
function promptsOf(raw: unknown): JournalPrompts {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  const parsed = JournalPromptsSchema.safeParse(value)
  return parsed.success ? parsed.data : {}
}

export function toJournalEntryView(r: EntryDbRow): JournalEntryView {
  return {
    id: r.id,
    localDate: r.localDate,
    body: r.body,
    prompts: promptsOf(r.prompts),
    origin: r.origin,
    transcriptStatus: r.transcriptStatus,
    transcriptDraft: r.transcriptDraft,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

function promptsJson(tx: Tx, prompts: JournalPrompts): postgres.Parameter {
  return tx.json(prompts as postgres.JSONValue)
}

export async function getJournalEntry(tx: Tx, localDate: string): Promise<JournalEntryView | null> {
  const [row] = await tx<EntryDbRow[]>`
    select id, local_date, body, prompts::text as prompts, origin, transcript_status, transcript_draft, version, created_at, updated_at
    from public.journal_entries where local_date = ${localDate}::date
  `
  return row ? toJournalEntryView(row) : null
}

async function lockJournalEntry(tx: Tx, localDate: string): Promise<JournalEntryView | null> {
  const [row] = await tx<EntryDbRow[]>`
    select id, local_date, body, prompts::text as prompts, origin, transcript_status, transcript_draft, version, created_at, updated_at
    from public.journal_entries where local_date = ${localDate}::date
    for update
  `
  return row ? toJournalEntryView(row) : null
}

/** The entry for a date, created empty if it does not exist yet (safe under concurrency). */
export async function ensureJournalEntry(
  tx: Tx,
  localDate: string,
  origin: JournalOrigin,
): Promise<JournalEntryView> {
  CalendarDateSchema.parse(localDate)
  await tx`
    insert into public.journal_entries (local_date, origin) values (${localDate}::date, ${origin})
    on conflict (local_date) do nothing
  `
  const entry = await getJournalEntry(tx, localDate)
  if (!entry) throw new Error('journal entry is not visible after insert')
  return entry
}

export interface JournalEntrySummary {
  id: string
  localDate: string
  /** First part of the body, or the first answered prompt. */
  preview: string
  origin: JournalOrigin
  transcriptStatus: JournalTranscriptStatus | null
  hasTranscriptDraft: boolean
  recordings: number
  updatedAt: string
}

/** Most recent dates first. `before` pages backwards. */
export async function listJournalEntries(
  tx: Tx,
  o: { limit?: number; before?: string | null; now?: Date } = {},
): Promise<JournalEntrySummary[]> {
  const limit = Math.min(Math.max(Math.trunc(o.limit ?? 30), 1), 200)
  const now = o.now ?? new Date()
  const rows = await tx<
    Array<{
      id: string
      localDate: string
      head: string
      prompts: unknown
      origin: JournalOrigin
      transcriptStatus: JournalTranscriptStatus | null
      hasTranscriptDraft: boolean
      recordings: number
      updatedAt: Date
    }>
  >`
    select e.id, e.local_date, left(e.body, 400) as head, e.prompts::text as prompts, e.origin, e.transcript_status,
      (e.transcript_draft is not null and btrim(e.transcript_draft) <> '') as has_transcript_draft,
      (select count(*)::int from public.journal_recordings r
        where r.entry_id = e.id and r.expires_at > ${now}::timestamptz) as recordings,
      e.updated_at
    from public.journal_entries e
    where (${o.before ?? null}::date is null or e.local_date < ${o.before ?? null}::date)
    order by e.local_date desc
    limit ${limit}
  `
  return rows.map((r) => {
    const prompts = promptsOf(r.prompts)
    const source =
      r.head.trim() !== '' ? r.head : (Object.values(prompts).find((v) => v && v.trim() !== '') ?? '')
    const flat = source.replace(/\s+/g, ' ').trim()
    return {
      id: r.id,
      localDate: r.localDate,
      preview: flat.length > 160 ? `${flat.slice(0, 159)}…` : flat,
      origin: r.origin,
      transcriptStatus: r.transcriptStatus,
      hasTranscriptDraft: r.hasTranscriptDraft,
      recordings: r.recordings,
      updatedAt: r.updatedAt.toISOString(),
    }
  })
}

/**
 * Save the typed part (body + prompts). Same rules as notes: baseVersion 0 creates (or, when the
 * day's entry already exists, compares); otherwise the write only lands on the named version.
 */
export async function saveJournalEntry(tx: Tx, input: JournalEntrySaveInput): Promise<JournalEntrySaveResult> {
  const parsed = JournalEntrySaveInputSchema.safeParse(input)
  if (!parsed.success) return { status: 'invalid', issues: notesZodIssues(parsed.error) }
  const { localDate, baseVersion, content } = parsed.data

  if (baseVersion === 0) {
    const [inserted] = await tx<EntryDbRow[]>`
      insert into public.journal_entries (local_date, body, prompts, origin)
      values (${localDate}::date, ${content.body}, ${promptsJson(tx, content.prompts)}::jsonb, 'typed')
      on conflict (local_date) do nothing
      returning id, local_date, body, prompts::text as prompts, origin, transcript_status, transcript_draft, version, created_at, updated_at
    `
    if (inserted) return { status: 'saved', entry: toJournalEntryView(inserted) }
  } else {
    const [updated] = await tx<EntryDbRow[]>`
      update public.journal_entries set
        body = ${content.body},
        prompts = ${promptsJson(tx, content.prompts)}::jsonb,
        version = version + 1
      where local_date = ${localDate}::date and version = ${baseVersion}
      returning id, local_date, body, prompts::text as prompts, origin, transcript_status, transcript_draft, version, created_at, updated_at
    `
    if (updated) return { status: 'saved', entry: toJournalEntryView(updated) }
  }

  const current = await getJournalEntry(tx, localDate)
  if (!current) {
    // The day's entry was removed after this device loaded it; keep the owner's text.
    if (baseVersion > 0) return saveJournalEntry(tx, { localDate, baseVersion: 0, content })
    return { status: 'error', code: 'entry_not_visible' }
  }
  if (journalContentEqual({ body: current.body, prompts: current.prompts }, content)) {
    return { status: 'saved', entry: current }
  }
  return { status: 'conflict', server: current }
}

export interface JournalSearchHit {
  id: string
  localDate: string
  snippet: string
  rank: number
}

const MARKERS = NOTES_HIGHLIGHT_START + NOTES_HIGHLIGHT_STOP
const HEADLINE_OPTIONS = `StartSel=${NOTES_HIGHLIGHT_START}, StopSel=${NOTES_HIGHLIGHT_STOP}, MaxWords=30, MinWords=12, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … "`

/** Full-text search over journal bodies (generated `search` column). */
export async function searchJournalEntries(
  tx: Tx,
  query: string,
  o: { limit?: number } = {},
): Promise<JournalSearchHit[]> {
  const tsq = notesSearchTsQuery(query)
  if (!tsq) return []
  const limit = Math.min(Math.max(Math.trunc(o.limit ?? 20), 1), 100)
  const rows = await tx<JournalSearchHit[]>`
    select e.id, e.local_date,
      ts_headline('simple', translate(e.body, ${MARKERS}, ''), q, ${HEADLINE_OPTIONS}) as snippet,
      ts_rank_cd(e.search, q)::float8 as rank
    from public.journal_entries e, to_tsquery('simple', ${tsq}) q
    where e.search @@ q
    order by rank desc, e.local_date desc
    limit ${limit}
  `
  return [...rows]
}

/**
 * Recompute the entry-level transcript status from its draft and live recordings, so the summary
 * column never claims more than the rows behind it.
 */
export async function refreshJournalTranscriptStatus(tx: Tx, entryId: string): Promise<void> {
  await tx`
    with s as (
      select case
        when e.transcript_draft is not null and btrim(e.transcript_draft) <> '' then 'ready_for_review'
        when exists (select 1 from public.journal_recordings r where r.entry_id = e.id and r.status = 'transcribing')
          then 'transcribing'
        when exists (select 1 from public.journal_recordings r where r.entry_id = e.id and r.status in ('uploading', 'uploaded'))
          then 'pending'
        when exists (select 1 from public.journal_recordings r
                     where r.entry_id = e.id and r.status = 'failed' and r.failure_reason = 'not_configured')
          then 'unavailable'
        when exists (select 1 from public.journal_recordings r where r.entry_id = e.id and r.status = 'failed')
          then 'failed'
        when e.transcript_status = 'saved' then 'saved'
        else null
      end as status
      from public.journal_entries e where e.id = ${entryId}::uuid
    )
    update public.journal_entries e set transcript_status = s.status
    from s
    where e.id = ${entryId}::uuid and e.transcript_status is distinct from s.status
  `
}

/**
 * Add the owner-reviewed transcript to the entry, in one transaction:
 *   - only if the draft is still exactly what the device showed (a newer transcript that arrived
 *     meanwhile is never cleared unseen) and the typed text is at `baseVersion`;
 *   - appends the reviewed text to the body (version + 1), clears the draft;
 *   - deletes the recordings that produced it (brief §7: delete once the transcript is saved).
 */
export async function saveJournalTranscript(
  tx: Tx,
  input: JournalTranscriptSaveInput,
): Promise<JournalTranscriptSaveResult> {
  const parsed = JournalTranscriptSaveInputSchema.safeParse(input)
  if (!parsed.success) return { status: 'invalid', issues: notesZodIssues(parsed.error) }
  const { localDate, baseVersion, draftSeen, text } = parsed.data
  if (text.trim() === '') return { status: 'invalid', issues: ['text: the transcript is empty (discard it instead)'] }

  const entry = await lockJournalEntry(tx, localDate)
  if (!entry) return { status: 'not_found' }
  if ((entry.transcriptDraft ?? '') !== draftSeen || entry.transcriptDraft === null) {
    return { status: 'draft_changed', entry }
  }
  if (entry.version !== baseVersion) return { status: 'conflict', entry }

  const body = journalAppendText(entry.body, text)
  if (body.length > JOURNAL_BODY_MAX) return { status: 'too_long' }

  const [row] = await tx<EntryDbRow[]>`
    update public.journal_entries set
      body = ${body},
      transcript_draft = null,
      transcript_status = 'saved',
      version = version + 1
    where id = ${entry.id}::uuid
    returning id, local_date, body, prompts::text as prompts, origin, transcript_status, transcript_draft, version, created_at, updated_at
  `
  const deleted = await tx`
    delete from public.journal_recordings where entry_id = ${entry.id}::uuid and status = 'transcribed'
    returning id
  `
  await refreshJournalTranscriptStatus(tx, entry.id)
  const saved = await getJournalEntry(tx, localDate)
  return { status: 'saved', entry: saved ?? toJournalEntryView(row!), recordingsDeleted: deleted.length }
}

export type JournalTranscriptDiscardResult =
  | { status: 'discarded'; entry: JournalEntryView }
  | { status: 'draft_changed'; entry: JournalEntryView }
  | { status: 'not_found' }
  | { status: 'invalid'; issues: string[] }

/**
 * Drop the waiting transcript without adding it. The recordings stay (as failed, with Retry /
 * Download / Delete and their original expiry) so nothing the owner said is lost by one click.
 */
export async function discardJournalTranscript(
  tx: Tx,
  input: JournalTranscriptDiscardInput,
): Promise<JournalTranscriptDiscardResult> {
  const parsed = JournalTranscriptDiscardInputSchema.safeParse(input)
  if (!parsed.success) return { status: 'invalid', issues: notesZodIssues(parsed.error) }
  const entry = await lockJournalEntry(tx, parsed.data.localDate)
  if (!entry) return { status: 'not_found' }
  if (entry.transcriptDraft === null || entry.transcriptDraft !== parsed.data.draftSeen) {
    return { status: 'draft_changed', entry }
  }
  await tx`update public.journal_entries set transcript_draft = null where id = ${entry.id}::uuid`
  await tx`
    update public.journal_recordings
    set status = 'failed', failure_reason = 'transcript_discarded'
    where entry_id = ${entry.id}::uuid and status = 'transcribed'
  `
  await refreshJournalTranscriptStatus(tx, entry.id)
  return { status: 'discarded', entry: (await getJournalEntry(tx, parsed.data.localDate))! }
}
