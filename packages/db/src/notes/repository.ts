/**
 * public.notes access. Owner transactions (withOwner) in the web app; RLS limits every
 * statement to the dashboard owner.
 *
 * Optimistic concurrency: every saved edit increments `version`, and a writer names the version
 * its edit started from. A stale write changes nothing and returns the current note, so the
 * device can show both versions and let the owner keep one or merge (never a silent overwrite).
 */
import {
  NOTES_HIGHLIGHT_START,
  NOTES_HIGHLIGHT_STOP,
  NoteSaveInputSchema,
  notesContentEqual,
  notesContentOf,
  notesSearchTsQuery,
  notesZodIssues,
  type NoteSaveInput,
  type NoteSaveResult,
  type NoteView,
} from '@personal-home/core'
import type { Tx } from '../client.ts'

interface NoteDbRow {
  id: string
  title: string | null
  body: string
  pinned: boolean
  projectId: string | null
  linkedDate: string | null
  bookId: string | null
  personId: string | null
  version: number
  createdAt: Date
  updatedAt: Date
}

function toNoteView(r: NoteDbRow): NoteView {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    pinned: r.pinned,
    projectId: r.projectId,
    linkedDate: r.linkedDate,
    bookId: r.bookId,
    personId: r.personId,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

export async function getNote(tx: Tx, id: string): Promise<NoteView | null> {
  const [row] = await tx<NoteDbRow[]>`
    select id, title, body, pinned, project_id, linked_date, book_id, person_id, version, created_at, updated_at
    from public.notes where id = ${id}::uuid
  `
  return row ? toNoteView(row) : null
}

export interface NoteListItem {
  id: string
  title: string | null
  /** The first part of the body, for list previews. */
  preview: string
  pinned: boolean
  linkedDate: string | null
  version: number
  updatedAt: string
}

export type NoteListView = 'recent' | 'pinned'

/** Pinned first, then most recently edited. `pinned` lists only pinned notes. */
export async function listNotes(
  tx: Tx,
  o: { view?: NoteListView; limit?: number; linkedDate?: string | null } = {},
): Promise<NoteListItem[]> {
  const limit = Math.min(Math.max(Math.trunc(o.limit ?? 50), 1), 200)
  const pinnedOnly = o.view === 'pinned'
  const rows = await tx<
    Array<{
      id: string
      title: string | null
      preview: string
      pinned: boolean
      linkedDate: string | null
      version: number
      updatedAt: Date
    }>
  >`
    select id, title, left(body, 300) as preview, pinned, linked_date, version, updated_at
    from public.notes
    where (${pinnedOnly}::boolean = false or pinned)
      and (${o.linkedDate ?? null}::date is null or linked_date = ${o.linkedDate ?? null}::date)
    order by pinned desc, updated_at desc, id
    limit ${limit}
  `
  return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }))
}

export async function countNotes(tx: Tx): Promise<number> {
  const [row] = await tx<{ n: number }[]>`select count(*)::int as n from public.notes`
  return row?.n ?? 0
}

/**
 * Create (baseVersion 0, device-generated id) or update (baseVersion = the version edited).
 * Idempotent: repeating a save whose response was lost returns the stored note instead of a
 * conflict when the stored content already equals the submitted content.
 */
export async function saveNote(tx: Tx, input: NoteSaveInput): Promise<NoteSaveResult> {
  const parsed = NoteSaveInputSchema.safeParse(input)
  if (!parsed.success) return { status: 'invalid', issues: notesZodIssues(parsed.error) }
  const { id, baseVersion, content: c } = parsed.data

  if (baseVersion === 0) {
    const [inserted] = await tx<NoteDbRow[]>`
      insert into public.notes (id, title, body, pinned, project_id, linked_date, book_id, person_id)
      values (${id}::uuid, ${c.title}, ${c.body}, ${c.pinned}, ${c.projectId}::uuid, ${c.linkedDate}::date,
              ${c.bookId}::uuid, ${c.personId}::uuid)
      on conflict (id) do nothing
      returning id, title, body, pinned, project_id, linked_date, book_id, person_id, version, created_at, updated_at
    `
    if (inserted) return { status: 'saved', note: toNoteView(inserted) }
  } else {
    const [updated] = await tx<NoteDbRow[]>`
      update public.notes set
        title = ${c.title},
        body = ${c.body},
        pinned = ${c.pinned},
        project_id = ${c.projectId}::uuid,
        linked_date = ${c.linkedDate}::date,
        book_id = ${c.bookId}::uuid,
        person_id = ${c.personId}::uuid,
        version = version + 1
      where id = ${id}::uuid and version = ${baseVersion}
      returning id, title, body, pinned, project_id, linked_date, book_id, person_id, version, created_at, updated_at
    `
    if (updated) return { status: 'saved', note: toNoteView(updated) }
  }

  const current = await getNote(tx, id)
  if (!current) return { status: 'not_found' }
  if (notesContentEqual(notesContentOf(current), c)) return { status: 'saved', note: current }
  return { status: 'conflict', server: current }
}

/** Pin or unpin from a list. Counts as an edit (version + 1) so open editors notice it. */
export async function setNotePinned(tx: Tx, id: string, pinned: boolean): Promise<NoteView | null> {
  const [row] = await tx<NoteDbRow[]>`
    update public.notes set pinned = ${pinned}, version = version + (case when pinned = ${pinned} then 0 else 1 end)
    where id = ${id}::uuid
    returning id, title, body, pinned, project_id, linked_date, book_id, person_id, version, created_at, updated_at
  `
  return row ? toNoteView(row) : null
}

export async function deleteNote(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx`delete from public.notes where id = ${id}::uuid returning id`
  return rows.length > 0
}

export interface NoteSearchHit {
  id: string
  title: string | null
  /** Title with highlight markers (NOTES_HIGHLIGHT_START/STOP); null when the note has no title. */
  titleHighlight: string | null
  /** Up to two body fragments with highlight markers. */
  snippet: string
  pinned: boolean
  linkedDate: string | null
  updatedAt: string
  rank: number
}

const MARKERS = NOTES_HIGHLIGHT_START + NOTES_HIGHLIGHT_STOP
const BODY_HEADLINE_OPTIONS = `StartSel=${NOTES_HIGHLIGHT_START}, StopSel=${NOTES_HIGHLIGHT_STOP}, MaxWords=30, MinWords=12, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … "`
const TITLE_HEADLINE_OPTIONS = `StartSel=${NOTES_HIGHLIGHT_START}, StopSel=${NOTES_HIGHLIGHT_STOP}, HighlightAll=true`

/**
 * Full-text search over the generated `search` column (title weighted above body), best match
 * first. Snippets come from ts_headline; the source text is stripped of the marker characters
 * first, so markers in the result are always Postgres's own.
 */
export async function searchNotes(tx: Tx, query: string, o: { limit?: number } = {}): Promise<NoteSearchHit[]> {
  const tsq = notesSearchTsQuery(query)
  if (!tsq) return []
  const limit = Math.min(Math.max(Math.trunc(o.limit ?? 20), 1), 100)
  const rows = await tx<
    Array<Omit<NoteSearchHit, 'updatedAt'> & { updatedAt: Date }>
  >`
    select n.id, n.title, n.pinned, n.linked_date, n.updated_at,
      case when n.title is null then null
        else ts_headline('simple', translate(n.title, ${MARKERS}, ''), q, ${TITLE_HEADLINE_OPTIONS}) end as title_highlight,
      ts_headline('simple', translate(n.body, ${MARKERS}, ''), q, ${BODY_HEADLINE_OPTIONS}) as snippet,
      ts_rank_cd(n.search, q)::float8 as rank
    from public.notes n, to_tsquery('simple', ${tsq}) q
    where n.search @@ q
    order by rank desc, n.updated_at desc, n.id
    limit ${limit}
  `
  return rows.map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }))
}

export interface NoteLinkOption {
  id: string
  label: string
}

export interface NoteLinkOptions {
  /** Empty when the projects table does not exist yet (capture area not merged). */
  projects: NoteLinkOption[]
  books: NoteLinkOption[]
  people: NoteLinkOption[]
}

/**
 * Choices for the note link fields. public.projects belongs to the capture area and may not exist
 * in this database yet: it is checked with to_regclass and read inside a savepoint, so a missing
 * or differently shaped table yields [] instead of aborting the transaction.
 */
export async function listNoteLinkOptions(tx: Tx): Promise<NoteLinkOptions> {
  const [reg] = await tx<{ present: boolean }[]>`select to_regclass('public.projects') is not null as present`
  let projects: NoteLinkOption[] = []
  if (reg?.present) {
    try {
      projects = await tx.savepoint(async (sp) => {
        const rows = await sp<NoteLinkOption[]>`
          select id, name as label from public.projects where status <> 'done' order by name limit 200
        `
        return [...rows]
      })
    } catch {
      projects = []
    }
  }
  const books = await tx<NoteLinkOption[]>`
    select id, title as label from public.books
    order by (status = 'reading') desc, title limit 200
  `
  const people = await tx<NoteLinkOption[]>`select id, name as label from public.people order by name limit 500`
  return { projects, books: [...books], people: [...people] }
}
