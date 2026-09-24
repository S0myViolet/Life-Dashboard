/**
 * Notes against a real Postgres (template = shim + all migrations), as the owner through RLS.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EMPTY_NOTE_CONTENT,
  NOTES_HIGHLIGHT_START as S,
  NOTES_HIGHLIGHT_STOP as E,
  notesHighlightSegments,
  type NoteContentInput,
} from '@personal-home/core'
import {
  deleteNote,
  getNote,
  listNoteLinkOptions,
  listNotes,
  saveNote,
  searchNotes,
  setNotePinned,
  withOwner,
  type OwnerClaims,
  type Tx,
} from '../src/index.ts'
import {
  createAuthUser,
  createTestDatabase,
  seedOwner,
  withAnon,
  type TestDatabase,
} from './harness.ts'

let t: TestDatabase
let owner: OwnerClaims
let stranger: OwnerClaims

beforeAll(async () => {
  t = await createTestDatabase()
  owner = await seedOwner(t.db)
  stranger = await createAuthUser(t.db, 'stranger@example.com')
})
afterAll(async () => {
  await t?.drop()
})

const asOwner = <T>(fn: (tx: Tx) => Promise<T>) => withOwner(t.db, owner, fn)
const content = (c: Partial<NoteContentInput>): NoteContentInput => ({
  ...EMPTY_NOTE_CONTENT,
  ...c,
})

describe('saving notes with optimistic concurrency', () => {
  it('creates with a device id, and a repeated create (lost response) is idempotent', async () => {
    const id = randomUUID()
    const first = await asOwner((tx) =>
      saveNote(tx, { id, baseVersion: 0, content: content({ body: 'hello' }) }),
    )
    expect(first.status).toBe('saved')
    if (first.status !== 'saved') return
    expect(first.note.version).toBe(1)

    const again = await asOwner((tx) =>
      saveNote(tx, { id, baseVersion: 0, content: content({ body: 'hello' }) }),
    )
    expect(again).toEqual({ status: 'saved', note: first.note })

    // Same id, different text from a "create": the note exists, so it is a conflict, not an overwrite.
    const other = await asOwner((tx) =>
      saveNote(tx, { id, baseVersion: 0, content: content({ body: 'other' }) }),
    )
    expect(other.status).toBe('conflict')
    expect((await asOwner((tx) => getNote(tx, id)))?.body).toBe('hello')
  })

  it('updates only from the current version and never silently overwrites a newer save', async () => {
    const id = randomUUID()
    await asOwner((tx) =>
      saveNote(tx, { id, baseVersion: 0, content: content({ title: 'T', body: 'v1' }) }),
    )
    const laptop = await asOwner((tx) =>
      saveNote(tx, {
        id,
        baseVersion: 1,
        content: content({ title: 'T', body: 'v2 from laptop' }),
      }),
    )
    expect(laptop.status).toBe('saved')
    if (laptop.status === 'saved') expect(laptop.note.version).toBe(2)

    // The phone still edits version 1.
    const phone = await asOwner((tx) =>
      saveNote(tx, { id, baseVersion: 1, content: content({ title: 'T', body: 'v2 from phone' }) }),
    )
    expect(phone.status).toBe('conflict')
    if (phone.status === 'conflict') {
      expect(phone.server.body).toBe('v2 from laptop')
      expect(phone.server.version).toBe(2)
    }
    const stored = await asOwner((tx) => getNote(tx, id))
    expect(stored?.body).toBe('v2 from laptop')

    // Resolving: the owner kept the phone's text, saved against the version it has now seen.
    const resolved = await asOwner((tx) =>
      saveNote(tx, { id, baseVersion: 2, content: content({ title: 'T', body: 'v2 from phone' }) }),
    )
    expect(resolved.status).toBe('saved')
    if (resolved.status === 'saved') expect(resolved.note.version).toBe(3)
  })

  it('treats a retried update whose response was lost as saved', async () => {
    const id = randomUUID()
    await asOwner((tx) => saveNote(tx, { id, baseVersion: 0, content: content({ body: 'a' }) }))
    await asOwner((tx) => saveNote(tx, { id, baseVersion: 1, content: content({ body: 'b' }) }))
    const retry = await asOwner((tx) =>
      saveNote(tx, { id, baseVersion: 1, content: content({ body: 'b' }) }),
    )
    expect(retry.status).toBe('saved')
    if (retry.status === 'saved') expect(retry.note.version).toBe(2)
  })

  it('reports not_found for an edit to a deleted note (the device keeps its text)', async () => {
    const id = randomUUID()
    await asOwner((tx) => saveNote(tx, { id, baseVersion: 0, content: content({ body: 'x' }) }))
    expect(await asOwner((tx) => deleteNote(tx, id))).toBe(true)
    expect(
      await asOwner((tx) => saveNote(tx, { id, baseVersion: 1, content: content({ body: 'y' }) })),
    ).toEqual({
      status: 'not_found',
    })
    expect(await asOwner((tx) => deleteNote(tx, id))).toBe(false)
  })

  it('validates input at the boundary and stores links', async () => {
    const bad = await asOwner((tx) =>
      saveNote(tx, {
        id: randomUUID(),
        baseVersion: 0,
        content: content({ title: 'x'.repeat(301) }),
      }),
    )
    expect(bad.status).toBe('invalid')

    const [book] = await t.db<
      { id: string }[]
    >`insert into public.books (title) values ('Dune') returning id`
    const [person] = await t.db<
      { id: string }[]
    >`insert into public.people (name) values ('Sam') returning id`
    const id = randomUUID()
    const saved = await asOwner((tx) =>
      saveNote(tx, {
        id,
        baseVersion: 0,
        content: content({
          body: 'linked',
          linkedDate: '2026-09-24',
          bookId: book!.id,
          personId: person!.id,
        }),
      }),
    )
    expect(saved.status).toBe('saved')
    if (saved.status === 'saved') {
      expect(saved.note).toMatchObject({
        linkedDate: '2026-09-24',
        bookId: book!.id,
        personId: person!.id,
      })
    }
    // Deleting the linked book clears the link, not the note.
    await t.db`delete from public.books where id = ${book!.id}`
    expect((await asOwner((tx) => getNote(tx, id)))?.bookId).toBeNull()
  })

  it('strips NUL characters that Postgres text cannot store', async () => {
    const id = randomUUID()
    const r = await asOwner((tx) =>
      saveNote(tx, { id, baseVersion: 0, content: content({ body: 'a\u0000b' }) }),
    )
    expect(r.status === 'saved' && r.note.body).toBe('ab')
  })
})

describe('listing', () => {
  it('lists pinned notes first, then most recently edited, with a pinned-only view', async () => {
    const ids: string[] = [randomUUID(), randomUUID(), randomUUID()]
    for (const [i, id] of ids.entries()) {
      await asOwner((tx) =>
        saveNote(tx, { id, baseVersion: 0, content: content({ title: `List ${i}` }) }),
      )
    }
    const pinned = await asOwner((tx) => setNotePinned(tx, ids[0]!, true))
    expect(pinned?.version).toBe(2)
    // Pinning again changes nothing and does not bump the version.
    expect((await asOwner((tx) => setNotePinned(tx, ids[0]!, true)))?.version).toBe(2)

    const all = await asOwner((tx) => listNotes(tx, { limit: 200 }))
    expect(all[0]?.id).toBe(ids[0])
    const listed = all.filter((n) => ids.includes(n.id)).map((n) => n.title)
    expect(listed).toEqual(['List 0', 'List 2', 'List 1'])
    const pinnedOnly = await asOwner((tx) => listNotes(tx, { view: 'pinned' }))
    expect(pinnedOnly.map((n) => n.id)).toEqual([ids[0]])
  })
})

describe('full-text search', () => {
  it('finds prefix matches in title and body, ranks title hits first and highlights them', async () => {
    const a = randomUUID()
    const b = randomUUID()
    await asOwner((tx) =>
      saveNote(tx, {
        id: a,
        baseVersion: 0,
        content: content({ title: 'Quarterly planning', body: 'Budget review with the team.' }),
      }),
    )
    await asOwner((tx) =>
      saveNote(tx, {
        id: b,
        baseVersion: 0,
        content: content({
          title: 'Groceries',
          body: 'Remember the planning poker cards and milk.',
        }),
      }),
    )
    const hits = await asOwner((tx) => searchNotes(tx, 'plan'))
    const mine = hits.filter((h) => h.id === a || h.id === b)
    expect(mine.map((h) => h.id)).toEqual([a, b])
    expect(mine[0]!.titleHighlight).toBe(`Quarterly ${S}planning${E}`)
    expect(mine[1]!.snippet).toContain(`${S}planning${E}`)
    expect(
      notesHighlightSegments(mine[1]!.snippet).some((s) => s.match && s.text === 'planning'),
    ).toBe(true)

    // All words must match.
    const both = await asOwner((tx) => searchNotes(tx, 'plan milk'))
    expect(both.map((h) => h.id)).toContain(b)
    expect(both.map((h) => h.id)).not.toContain(a)
  })

  it('never lets note text forge highlight markers, and survives operator-laden input', async () => {
    const id = randomUUID()
    await asOwner((tx) =>
      saveNote(tx, { id, baseVersion: 0, content: content({ body: `zebra ${S}fake${E} marker` }) }),
    )
    const [hit] = await asOwner((tx) => searchNotes(tx, 'zebra'))
    expect(hit?.snippet).toBe(`${S}zebra${E} fake marker`)
    expect(await asOwner((tx) => searchNotes(tx, `'); drop table public.notes; --`))).toEqual(
      expect.any(Array),
    )
    expect(await asOwner((tx) => searchNotes(tx, '!!! & |'))).toEqual([])
    expect((await t.db`select count(*)::int as n from public.notes`)[0]?.n).toBeGreaterThan(0)
  })
})

describe('link options', () => {
  it('offers active projects from public.projects as link options (owner only)', async () => {
    await t.db`
      insert into public.projects (name, kind, status)
      values ('Home office', 'personal', 'active'), ('Old', 'work', 'done')
    `
    const opts = await asOwner((tx) => listNoteLinkOptions(tx))
    expect(opts.projects.map((p) => p.label)).toEqual(['Home office'])
    expect(opts.people.map((p) => p.label)).toContain('Sam')

    // RLS: a signed-in user who is not the owner sees no projects.
    const seen = await withOwner(t.db, stranger, (tx) => listNoteLinkOptions(tx))
    expect(seen.projects).toEqual([])
    await t.db`delete from public.projects`
  })
})

describe('row level security', () => {
  it('hides notes from anon and from a signed-in user who is not the owner', async () => {
    const id = randomUUID()
    await asOwner((tx) =>
      saveNote(tx, { id, baseVersion: 0, content: content({ body: 'private' }) }),
    )

    await expect(withAnon(t.db, (tx) => tx`select id from public.notes`)).rejects.toThrow(
      /permission denied/,
    )
    const seen = await withOwner(t.db, stranger, (tx) => listNotes(tx, { limit: 200 }))
    expect(seen).toEqual([])
    expect(await withOwner(t.db, stranger, (tx) => searchNotes(tx, 'private'))).toEqual([])
    expect(
      await withOwner(t.db, stranger, (tx) =>
        saveNote(tx, { id, baseVersion: 1, content: content({ body: 'x' }) }),
      ),
    ).toEqual({ status: 'not_found' })
    await expect(
      withOwner(t.db, stranger, (tx) =>
        saveNote(tx, { id: randomUUID(), baseVersion: 0, content: content({ body: 'x' }) }),
      ),
    ).rejects.toThrow(/row-level security/)
    expect(await withOwner(t.db, stranger, (tx) => deleteNote(tx, id))).toBe(false)
    expect((await asOwner((tx) => getNote(tx, id)))?.body).toBe('private')
  })
})
