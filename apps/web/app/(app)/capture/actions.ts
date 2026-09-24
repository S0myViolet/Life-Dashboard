'use server'

/**
 * Server Actions for notes and journal text. Every action authenticates the owner itself (the
 * page gating is not a security boundary), validates its input with zod in the repository, runs
 * in an owner transaction (RLS enforced) and returns a small typed result — never a redirect, so a
 * background sync can never navigate the owner away from what they are typing.
 *
 * Nothing here logs note or journal content.
 */
import { z } from 'zod'
import type {
  JournalEntrySaveResult,
  JournalTranscriptSaveResult,
  NoteSaveResult,
} from '@personal-home/core'
import {
  deleteNote,
  discardJournalTranscript,
  saveJournalEntry,
  saveJournalTranscript,
  saveNote,
  searchJournalEntries,
  searchNotes,
  type JournalSearchHit,
  type NoteSearchHit,
  type JournalTranscriptDiscardResult,
} from '@personal-home/db'
import { ownerTransaction } from '@/lib/server/db'
import { getOwner } from '@/lib/server/session'

type Unauthorized = { status: 'unauthorized' }
type Failed = { status: 'error'; code: string }

async function asOwner<T>(fn: Parameters<typeof ownerTransaction<T>>[1]): Promise<T | Unauthorized | Failed> {
  const owner = await getOwner().catch(() => null)
  if (!owner) return { status: 'unauthorized' }
  try {
    return await ownerTransaction(owner.claims, fn)
  } catch {
    // Database unreachable or a constraint we did not anticipate. The device keeps its draft.
    return { status: 'error', code: 'database' }
  }
}

export async function saveNoteAction(input: unknown): Promise<NoteSaveResult> {
  return asOwner((tx) => saveNote(tx, input as Parameters<typeof saveNote>[1]))
}

const IdSchema = z.uuid()

export async function deleteNoteAction(id: unknown): Promise<{ status: 'deleted' | 'not_found' } | Unauthorized | Failed> {
  const parsed = IdSchema.safeParse(id)
  if (!parsed.success) return { status: 'not_found' }
  return asOwner(async (tx) => ((await deleteNote(tx, parsed.data)) ? { status: 'deleted' as const } : { status: 'not_found' as const }))
}

export async function saveJournalEntryAction(input: unknown): Promise<JournalEntrySaveResult> {
  return asOwner((tx) => saveJournalEntry(tx, input as Parameters<typeof saveJournalEntry>[1]))
}

export async function saveJournalTranscriptAction(input: unknown): Promise<JournalTranscriptSaveResult> {
  return asOwner((tx) => saveJournalTranscript(tx, input as Parameters<typeof saveJournalTranscript>[1]))
}

export async function discardJournalTranscriptAction(
  input: unknown,
): Promise<JournalTranscriptDiscardResult | Unauthorized | Failed> {
  return asOwner((tx) => discardJournalTranscript(tx, input as Parameters<typeof discardJournalTranscript>[1]))
}

const SearchQuerySchema = z.string().trim().min(1).max(200)

/**
 * Full-text search over notes and journal entries. A POST (Server Action) rather than a GET form,
 * so what the owner searches for never appears in URLs, browser history or access logs.
 */
export async function searchCaptureAction(
  query: unknown,
): Promise<{ status: 'ok'; notes: NoteSearchHit[]; journal: JournalSearchHit[] } | { status: 'invalid' } | Unauthorized | Failed> {
  const parsed = SearchQuerySchema.safeParse(query)
  if (!parsed.success) return { status: 'invalid' }
  return asOwner(async (tx) => ({
    status: 'ok' as const,
    notes: await searchNotes(tx, parsed.data, { limit: 30 }),
    journal: await searchJournalEntries(tx, parsed.data, { limit: 20 }),
  }))
}
