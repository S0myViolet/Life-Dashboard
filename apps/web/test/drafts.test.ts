/**
 * Offline draft decisions and the sync engine (memory mode: Node has no IndexedDB, which is also
 * how a storage-blocked browser behaves). IndexedDB persistence across reloads is covered by the
 * Playwright journal/notes specs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_NOTE_CONTENT, type NoteContent, type NoteView } from '@personal-home/core'

const saveNoteAction = vi.fn()
const saveJournalEntryAction = vi.fn()
vi.mock('@/app/(app)/capture/actions', () => ({ saveNoteAction, saveJournalEntryAction }))

const {
  draftAfterSend,
  draftIndicator,
  draftOnLoad,
  draftResolve,
  draftRetryDelayMs,
  newDraft,
  SYNC_INDICATOR_LABELS,
} = await import('@/lib/drafts/logic')
const { journalTransport, noteTransport } = await import('@/lib/drafts/transports')
const { getDraftEngine } = await import('@/lib/drafts/engine')

const note = (c: Partial<NoteContent>): NoteContent => ({ ...EMPTY_NOTE_CONTENT, ...c })
const NOW = 1_000_000

describe('status labels', () => {
  it('uses the owner-facing words from the brief', () => {
    expect(SYNC_INDICATOR_LABELS.saved_local).toBe('Saved on this device')
    expect(SYNC_INDICATOR_LABELS.synced).toBe('Synced')
    expect(SYNC_INDICATOR_LABELS.waiting).toBe('Waiting to sync')
  })

  it('derives the indicator from the draft, storage and connectivity', () => {
    const d = newDraft('note', 'n', null, EMPTY_NOTE_CONTENT, note({ body: 'x' }), NOW)
    expect(draftIndicator(null, { persisted: true, online: true })).toBe('synced')
    expect(draftIndicator(d, { persisted: true, online: true })).toBe('saved_local')
    expect(draftIndicator(d, { persisted: true, online: false })).toBe('waiting')
    expect(draftIndicator({ ...d, attempts: 2 }, { persisted: true, online: true })).toBe('waiting')
    expect(draftIndicator(d, { persisted: false, online: true })).toBe('not_saved')
    expect(draftIndicator({ ...d, state: 'conflict' }, { persisted: true, online: true })).toBe('conflict')
  })

  it('backs off 2 s, 5 s, 15 s, 30 s, then every minute', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(draftRetryDelayMs)).toEqual([0, 2000, 5000, 15000, 30000, 60000, 60000])
  })
})

describe('reconciling a stored draft with the server on load', () => {
  const base = note({ title: 'T', body: 'one\ntwo' })
  const draft = { ...newDraft('note', 'n', { version: 3, content: base }, EMPTY_NOTE_CONTENT, note({ title: 'T', body: 'one\ntwo\nmine' }), NOW) }

  it('keeps a draft that is still based on the server version', () => {
    expect(draftOnLoad(draft, { version: 3, content: base }, noteTransport, NOW)).toEqual({ use: 'draft', draft })
  })

  it('discards a draft the server already has', () => {
    expect(draftOnLoad(draft, { version: 4, content: draft.value }, noteTransport, NOW)).toEqual({
      use: 'server',
      discard: true,
    })
  })

  it('merges cleanly onto a newer server version when different fields changed', () => {
    const r = draftOnLoad(draft, { version: 4, content: { ...base, pinned: true } }, noteTransport, NOW)
    expect(r.use).toBe('draft')
    if (r.use !== 'draft') return
    expect(r.draft).toMatchObject({ state: 'pending', baseVersion: 4, value: { body: 'one\ntwo\nmine', pinned: true } })
  })

  it('never silently overwrites: both sides changed the body → conflict with both versions kept', () => {
    const theirs = { ...base, body: 'one\ntwo\ntheirs' }
    const r = draftOnLoad(draft, { version: 4, content: theirs }, noteTransport, NOW)
    expect(r.use).toBe('draft')
    if (r.use !== 'draft') return
    expect(r.draft.state).toBe('conflict')
    expect(r.draft.value.body).toBe('one\ntwo\nmine')
    expect(r.draft.conflict).toMatchObject({ server: theirs, serverVersion: 4, fields: ['body'] })
    expect(r.draft.conflict!.proposal.body).toContain('mine')
    expect(r.draft.conflict!.proposal.body).toContain('theirs')
  })

  it('keeps an offline-created note, and flags edits to a note deleted elsewhere', () => {
    const offline = newDraft('note', 'n', null, EMPTY_NOTE_CONTENT, note({ body: 'new' }), NOW)
    expect(draftOnLoad(offline, null, noteTransport, NOW)).toEqual({ use: 'draft', draft: offline })
    const r = draftOnLoad(draft, null, noteTransport, NOW)
    expect(r.use === 'draft' && r.draft.state).toBe('deleted_remotely')
    expect(r.use === 'draft' && r.draft.value.body).toBe('one\ntwo\nmine')
  })

  it('recreates a journal day instead of asking when the server has none', () => {
    const j = newDraft('journal', '2026-09-24', { version: 2, content: { body: 'a', prompts: {} } }, { body: '', prompts: {} }, { body: 'a b', prompts: {} }, NOW)
    const r = draftOnLoad(j, null, journalTransport, NOW)
    expect(r.use === 'draft' && r.draft).toMatchObject({ state: 'pending', baseVersion: 0 })
  })
})

describe('applying a sync result', () => {
  const base = note({ body: 'a' })
  const d0 = newDraft('note', 'n', { version: 1, content: base }, EMPTY_NOTE_CONTENT, note({ body: 'a b' }), NOW)
  const sent = { value: d0.value, baseVersion: 1 }

  it('deletes the draft when the server has everything', () => {
    const r = draftAfterSend(d0, sent, { status: 'saved', server: { version: 2, content: d0.value } }, noteTransport, NOW)
    expect(r.action).toBe('delete')
  })

  it('keeps typing that happened during the request, rebased on the saved version', () => {
    const typedMore = { ...d0, value: note({ body: 'a b c' }) }
    const r = draftAfterSend(typedMore, sent, { status: 'saved', server: { version: 2, content: d0.value } }, noteTransport, NOW)
    expect(r.action).toBe('keep')
    if (r.action !== 'keep') return
    expect(r.draft).toMatchObject({ baseVersion: 2, base: d0.value, value: { body: 'a b c' }, state: 'pending' })
    expect(r.syncNow).toBe(true)
  })

  it('backs off on network errors and keeps the text', () => {
    const r = draftAfterSend(d0, sent, { status: 'retry', code: 'network' }, noteTransport, NOW)
    expect(r.action === 'keep' && r.draft).toMatchObject({ attempts: 1, nextAttemptAt: NOW + 2000, lastError: 'network', value: d0.value })
  })

  it('turns a stale write into a conflict (or a clean merge) instead of overwriting', () => {
    const theirs = note({ body: 'a\nfrom laptop' })
    const r = draftAfterSend(d0, sent, { status: 'conflict', server: { version: 2, content: theirs } }, noteTransport, NOW)
    expect(r.action === 'keep' && r.draft.state).toBe('conflict')
    const pinned = draftAfterSend(d0, sent, { status: 'conflict', server: { version: 2, content: { ...base, pinned: true } } }, noteTransport, NOW)
    expect(pinned.action === 'keep' && pinned.draft).toMatchObject({ state: 'pending', baseVersion: 2, value: { body: 'a b', pinned: true } })
  })

  it('marks rejected content and remotely deleted notes without dropping the text', () => {
    expect(draftAfterSend(d0, sent, { status: 'invalid' }, noteTransport, NOW)).toMatchObject({
      action: 'keep',
      draft: { state: 'rejected', value: d0.value },
    })
    expect(draftAfterSend(d0, sent, { status: 'not_found' }, noteTransport, NOW)).toMatchObject({
      action: 'keep',
      draft: { state: 'deleted_remotely', value: d0.value },
    })
  })

  it('resolves a conflict against the server version the owner has seen', () => {
    const c = draftAfterSend(d0, sent, { status: 'conflict', server: { version: 5, content: note({ body: 'x' }) } }, noteTransport, NOW)
    if (c.action !== 'keep') throw new Error('expected keep')
    expect(draftResolve(c.draft, { choice: 'mine' }, NOW)).toMatchObject({ baseVersion: 5, value: { body: 'a b' }, state: 'pending' })
    expect(draftResolve(c.draft, { choice: 'theirs' }, NOW)).toMatchObject({ baseVersion: 5, value: { body: 'x' } })
    expect(draftResolve(c.draft, { choice: 'merged', value: note({ body: 'both' }) }, NOW).value.body).toBe('both')
  })
})

describe('transports', () => {
  beforeEach(() => {
    saveNoteAction.mockReset()
    saveJournalEntryAction.mockReset()
  })
  const view = (c: NoteContent, version: number): NoteView => ({
    ...c,
    id: 'n',
    version,
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
  })
  const d = newDraft('note', '11111111-1111-4111-8111-111111111111', null, EMPTY_NOTE_CONTENT, note({ body: 'x' }), NOW)

  it('maps server action results; offline and signed-out become retries', async () => {
    saveNoteAction.mockResolvedValueOnce({ status: 'saved', note: view(d.value, 1) })
    expect(await noteTransport.send(d)).toEqual({ status: 'saved', server: { version: 1, content: d.value } })
    saveNoteAction.mockResolvedValueOnce({ status: 'unauthorized' })
    expect(await noteTransport.send(d)).toEqual({ status: 'retry', code: 'signed_out' })
    saveNoteAction.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect(await noteTransport.send(d)).toEqual({ status: 'retry', code: 'network' })
    saveNoteAction.mockResolvedValueOnce({ status: 'invalid', issues: [] })
    expect(await noteTransport.send(d)).toEqual({ status: 'invalid' })
    expect(saveNoteAction).toHaveBeenLastCalledWith({ id: d.targetId, baseVersion: 0, content: d.value })
  })

  it('compares normalised content (blank title = no title)', () => {
    expect(noteTransport.equal(note({ title: '  ' }), note({ title: null }))).toBe(true)
    expect(journalTransport.equal({ body: 'a', prompts: { next: ' ' } }, { body: 'a', prompts: {} })).toBe(true)
  })

  it('merges journal prompts field by field', () => {
    const base = { body: 'b', prompts: {} }
    const r = journalTransport.merge(base, { body: 'b', prompts: { next: 'Call Sam' } }, { body: 'b + laptop', prompts: {} })
    expect(r).toEqual({ status: 'clean', merged: { body: 'b + laptop', prompts: { next: 'Call Sam' } } })
  })
})

describe('draft engine (memory mode)', () => {
  it('syncs edits, keeps them through failures, and reports conflicts without overwriting', async () => {
    const engine = getDraftEngine()
    let server: { version: number; content: NoteContent } = { version: 1, content: note({ body: 'start' }) }
    let online = false
    engine.register('note', {
      ...noteTransport,
      async send(d) {
        if (!online) return { status: 'retry', code: 'network' }
        if (d.baseVersion !== server.version) return { status: 'conflict', server }
        server = { version: server.version + 1, content: d.value }
        return { status: 'saved', server }
      },
    })
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const snap = await engine.open('note', id, { version: 1, content: server.content })
    expect(snap.value.body).toBe('start')

    engine.edit('note', id, note({ body: 'start + offline edit' }))
    expect(await engine.flush('note', id)).toBe(false)
    expect(engine.snapshot<NoteContent>('note', id)).toMatchObject({ indicator: 'not_saved', value: { body: 'start + offline edit' } })

    online = true
    expect(await engine.flush('note', id)).toBe(true)
    expect(server).toEqual({ version: 2, content: note({ body: 'start + offline edit' }) })
    expect(engine.snapshot('note', id).indicator).toBe('synced')

    // Another device saves version 3 while this one edits version 2.
    engine.edit('note', id, note({ body: 'start + offline edit\nfrom phone' }))
    server = { version: 3, content: note({ body: 'start + offline edit\nfrom laptop' }) }
    expect(await engine.flush('note', id)).toBe(false)
    const conflicted = engine.snapshot<NoteContent>('note', id)
    expect(conflicted.indicator).toBe('conflict')
    expect(conflicted.draft?.conflict?.server.body).toContain('from laptop')
    expect(server.content.body).toContain('from laptop')

    engine.resolve('note', id, { choice: 'merged', value: note({ body: 'start + offline edit\nfrom phone\nfrom laptop' }) })
    expect(await engine.flush('note', id)).toBe(true)
    expect(server).toEqual({ version: 4, content: note({ body: 'start + offline edit\nfrom phone\nfrom laptop' }) })
  })
})
