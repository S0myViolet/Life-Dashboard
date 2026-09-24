/**
 * Notes: freeform typed entries with an optional title, optional links (project, date, book,
 * person) and optimistic concurrency. Pure validation and shapes shared by the database layer,
 * server actions and the offline draft store.
 */
import { z } from 'zod'
import { CalendarDateSchema } from '../time/index.ts'

export const NOTE_TITLE_MAX = 300
export const NOTE_BODY_MAX = 200_000

const NUL_RE = /\u0000/g

/** Postgres text cannot hold NUL; pasted binary junk is the only way to get one into a textarea. */
export function notesStripNul(value: string): string {
  return value.includes('\u0000') ? value.replace(NUL_RE, '') : value
}

const OptionalUuid = z.uuid().nullable()

export const NoteContentSchema = z.object({
  title: z
    .string()
    .max(NOTE_TITLE_MAX)
    .nullable()
    .transform((v) => {
      if (v === null) return null
      const s = notesStripNul(v)
      return s.trim() === '' ? null : s
    }),
  body: z.string().max(NOTE_BODY_MAX).transform(notesStripNul),
  pinned: z.boolean(),
  projectId: OptionalUuid,
  linkedDate: CalendarDateSchema.nullable(),
  bookId: OptionalUuid,
  personId: OptionalUuid,
})
export type NoteContent = z.output<typeof NoteContentSchema>
export type NoteContentInput = z.input<typeof NoteContentSchema>

export const EMPTY_NOTE_CONTENT: NoteContent = Object.freeze({
  title: null,
  body: '',
  pinned: false,
  projectId: null,
  linkedDate: null,
  bookId: null,
  personId: null,
})

/**
 * A save from an editor or the offline queue. `baseVersion` is the server version the edit
 * started from; 0 means "this note does not exist on the server yet" (the id is generated on
 * the device, so a retried create is idempotent).
 */
export const NoteSaveInputSchema = z.object({
  id: z.uuid(),
  baseVersion: z.number().int().min(0).max(2_147_483_647),
  content: NoteContentSchema,
})
export type NoteSaveInput = z.input<typeof NoteSaveInputSchema>

/** A note as the UI sees it. Timestamps are ISO strings so the shape survives JSON and IndexedDB. */
export interface NoteView extends NoteContent {
  id: string
  version: number
  createdAt: string
  updatedAt: string
}

export type NoteSaveResult =
  | { status: 'saved'; note: NoteView }
  /** The server moved on since `baseVersion`: nothing was written. `server` is the current note. */
  | { status: 'conflict'; server: NoteView }
  /** The note was deleted elsewhere. The caller still has its local text. */
  | { status: 'not_found' }
  | { status: 'invalid'; issues: string[] }
  | { status: 'unauthorized' }
  | { status: 'error'; code: string }

/** Normalise content the same way the server stores it (for equality checks). */
export function notesNormalizeContent(content: NoteContentInput): NoteContent {
  return NoteContentSchema.parse(content)
}

export function notesContentEqual(a: NoteContent, b: NoteContent): boolean {
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.pinned === b.pinned &&
    a.projectId === b.projectId &&
    a.linkedDate === b.linkedDate &&
    a.bookId === b.bookId &&
    a.personId === b.personId
  )
}

export function notesContentOf(note: NoteContent): NoteContent {
  return {
    title: note.title,
    body: note.body,
    pinned: note.pinned,
    projectId: note.projectId,
    linkedDate: note.linkedDate,
    bookId: note.bookId,
    personId: note.personId,
  }
}

/** A short plain-text label for lists: the title, else the first non-empty body line. */
export function notesDisplayTitle(note: Pick<NoteContent, 'title' | 'body'>, max = 80): string {
  const title = note.title?.trim()
  if (title) return title.length > max ? `${title.slice(0, max - 1)}…` : title
  const line = note.body.split('\n').find((l) => l.trim() !== '')?.trim() ?? ''
  if (!line) return 'Untitled note'
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function notesZodIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
}
