/**
 * How notes and journal drafts reach the server (Server Actions) and how their content is
 * compared and merged. Offline, timeouts, sign-outs and deploy skew all become "retry later";
 * nothing here throws into the editor.
 */
import {
  EMPTY_JOURNAL_CONTENT,
  EMPTY_NOTE_CONTENT,
  JOURNAL_TEXT_FIELDS,
  journalContentEqual,
  journalContentFields,
  journalContentFromFields,
  journalNormalizeContent,
  notesContentEqual,
  notesContentOf,
  notesMergeRecords,
  notesNormalizeContent,
  type JournalEntryContent,
  type JournalEntryView,
  type JournalPromptKey,
  type NoteContent,
  type NoteView,
} from '@personal-home/core'
import { saveJournalEntryAction, saveNoteAction } from '@/app/(app)/capture/actions'
import type { DraftTransport } from './engine'
import type { DraftSendResult } from './logic'

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

export function noteSnapshot(note: NoteView): { version: number; content: NoteContent } {
  return { version: note.version, content: notesContentOf(note) }
}

export const noteTransport: DraftTransport<NoteContent> = {
  empty: EMPTY_NOTE_CONTENT,
  equal(a, b) {
    return notesContentEqual(safe(() => notesNormalizeContent(a), a), safe(() => notesNormalizeContent(b), b))
  },
  merge(base, mine, theirs) {
    return notesMergeRecords(base, mine, theirs, ['title', 'body'])
  },
  async send(draft): Promise<DraftSendResult<NoteContent>> {
    try {
      const r = await saveNoteAction({ id: draft.targetId, baseVersion: draft.baseVersion, content: draft.value })
      switch (r.status) {
        case 'saved':
          return { status: 'saved', server: noteSnapshot(r.note) }
        case 'conflict':
          return { status: 'conflict', server: noteSnapshot(r.server) }
        case 'not_found':
          return { status: 'not_found' }
        case 'invalid':
          return { status: 'invalid' }
        case 'unauthorized':
          return { status: 'retry', code: 'signed_out' }
        default:
          return { status: 'retry', code: 'server_error' }
      }
    } catch {
      return { status: 'retry', code: 'network' }
    }
  },
}

export function journalSnapshot(entry: JournalEntryView): { version: number; content: JournalEntryContent } {
  return { version: entry.version, content: { body: entry.body, prompts: entry.prompts } }
}

type JournalFields = Record<'body' | JournalPromptKey, string>

export const journalTransport: DraftTransport<JournalEntryContent> = {
  empty: EMPTY_JOURNAL_CONTENT,
  // A day's entry is recreated rather than lost if it disappears on the server.
  recreateWhenMissing: true,
  equal(a, b) {
    return journalContentEqual(safe(() => journalNormalizeContent(a), a), safe(() => journalNormalizeContent(b), b))
  },
  merge(base, mine, theirs) {
    const m = notesMergeRecords<JournalFields>(
      journalContentFields(base),
      journalContentFields(mine),
      journalContentFields(theirs),
      [...JOURNAL_TEXT_FIELDS],
    )
    const back = (f: JournalFields): JournalEntryContent =>
      safe(() => journalContentFromFields(f), {
        body: f.body,
        prompts: {
          what_happened: f.what_happened,
          moved_forward: f.moved_forward,
          needs_attention: f.needs_attention,
          next: f.next,
        },
      })
    return m.status === 'clean'
      ? { status: 'clean', merged: back(m.merged) }
      : { status: 'conflict', fields: m.fields, proposal: back(m.proposal) }
  },
  async send(draft): Promise<DraftSendResult<JournalEntryContent>> {
    try {
      const r = await saveJournalEntryAction({
        localDate: draft.targetId,
        baseVersion: draft.baseVersion,
        content: draft.value,
      })
      switch (r.status) {
        case 'saved':
          return { status: 'saved', server: journalSnapshot(r.entry) }
        case 'conflict':
          return { status: 'conflict', server: journalSnapshot(r.server) }
        case 'invalid':
          return { status: 'invalid' }
        case 'unauthorized':
          return { status: 'retry', code: 'signed_out' }
        default:
          return { status: 'retry', code: 'server_error' }
      }
    } catch {
      return { status: 'retry', code: 'network' }
    }
  },
}
