import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  captureApplyOps,
  capturePrepareSnapshot,
  captureReconcile,
  type CaptureSnapshot,
  type CaptureStoredConversation,
} from '@personal-home/core'
import {
  captureIngestSnapshot,
  captureListConversations,
  captureListSelection,
  captureLoadConversationState,
  captureMarkState,
  captureSelectConversation,
  captureSetConversationPaused,
  withOwner,
  withService,
  type OwnerClaims,
} from '../src/index.ts'
import {
  CHAT_ID,
  CHAT_URL,
  CLAUDE_URL,
  at,
  makeSnapshot,
  thread,
  type FixtureMessage,
} from './capture-fixtures.ts'
import { createTestDatabase, seedOwner, type TestDatabase } from './harness.ts'

const databases: TestDatabase[] = []
let t: TestDatabase
let owner: OwnerClaims
let conversationId: string

beforeEach(async () => {
  t = await createTestDatabase()
  databases.push(t)
  owner = await seedOwner(t.db)
  const selected = await withOwner(t.db, owner, (tx) => captureSelectConversation(tx, { url: CHAT_URL }))
  if (selected.status !== 'selected') throw new Error('select failed')
  conversationId = selected.conversation.id
})
afterAll(async () => {
  for (const d of databases) await d.drop()
})

const ingest = (s: CaptureSnapshot, receivedAt = new Date('2030-01-01T00:00:00Z')) =>
  withService(t.db, (tx) => captureIngestSnapshot(tx, s, { receivedAt }))
const stored = () => withService(t.db, (tx) => captureLoadConversationState(tx, conversationId))
const count = async (table: string) =>
  (await withService(t.db, (tx) => tx.unsafe(`select count(*)::int as n from public.${table}`)))[0]!.n as number

async function model(snapshots: CaptureSnapshot[]): Promise<CaptureStoredConversation> {
  let state: CaptureStoredConversation = { messages: [] }
  for (const s of snapshots) {
    const prepared = await capturePrepareSnapshot(s, { receivedAt: new Date('2030-01-01T00:00:00Z') })
    state = captureApplyOps(state, captureReconcile(state, prepared).ops)
  }
  return state
}

describe('captureIngestSnapshot', () => {
  it('stores messages, versions and a snapshot record, and updates the conversation', async () => {
    const s = makeSnapshot(at(0), thread(4), { title: 'Trip planning' })
    const result = await ingest(s)
    expect(result).toEqual({
      status: 'ok',
      outcome: 'applied',
      reason: null,
      newMessages: 4,
      newVersions: 0,
      captureState: 'active',
      duplicate: false,
      contentChanged: true,
    })
    const [conv] = await withOwner(t.db, owner, (tx) => captureListConversations(tx))
    expect(conv).toMatchObject({
      title: 'Trip planning',
      messageCount: 4,
      lastCapturedAt: new Date(at(0)),
      lastSeenCompleteAt: new Date(at(0)),
    })
    expect(conv?.lastSnapshot).toMatchObject({
      outcome: 'applied',
      mode: 'passive',
      newMessages: 4,
      coverage: { observedFirstMessage: true, observedLastMessage: true, pageState: 'ok' },
    })
    expect(await stored()).toEqual(await model([s]))
  })

  it('answers a retried upload (same snapshotId) from the log without applying it twice', async () => {
    const s = makeSnapshot(at(0), thread(3))
    await ingest(s)
    const again = await ingest(s)
    expect(again).toMatchObject({ status: 'ok', duplicate: true, newMessages: 3, outcome: 'applied' })
    expect(await count('capture_snapshots')).toBe(1)
    expect(await count('captured_messages')).toBe(3)
  })

  it('refuses unselected and inactive conversations without touching data', async () => {
    expect(await ingest(makeSnapshot(at(0), thread(2), { provider: 'claude' }))).toEqual({
      status: 'not_selected',
    })
    await withOwner(t.db, owner, (tx) => captureSetConversationPaused(tx, conversationId, true))
    expect(await ingest(makeSnapshot(at(0), thread(2)))).toEqual({
      status: 'not_active',
      captureState: 'paused',
    })
    expect(await count('captured_messages')).toBe(0)
    expect(await count('capture_snapshots')).toBe(0)
  })

  it('a partial page after a full capture never shrinks the stored conversation', async () => {
    await ingest(makeSnapshot(at(0), thread(12)))
    const before = await stored()
    const partial = makeSnapshot(at(5), thread(12).slice(9), {
      coverage: { observedFirstMessage: false, renderedCount: 3, accumulatedCount: 3 },
    })
    const result = await ingest(partial)
    expect(result).toMatchObject({ outcome: 'applied', newMessages: 0, contentChanged: false })
    const after = await stored()
    expect(after.messages.map((m) => m.key)).toEqual(before.messages.map((m) => m.key))
    expect(after.messages.map((m) => m.currentHash)).toEqual(before.messages.map((m) => m.currentHash))
    const [conv] = await withOwner(t.db, owner, (tx) => captureListConversations(tx))
    expect(conv?.messageCount).toBe(12)
    expect(conv?.lastSeenCompleteAt).toEqual(new Date(at(0)))
    expect(conv?.lastCapturedAt).toEqual(new Date(at(5)))
    expect(conv?.lastSnapshot?.coverage.observedFirstMessage).toBe(false)
  })

  it('an edited message gets exactly one new version row and the old one is superseded', async () => {
    const base = thread(2)
    await ingest(makeSnapshot(at(0), base))
    const edited: FixtureMessage[] = [{ ...base[0]!, text: 'Question number 0, reworded' }, base[1]!]
    const result = await ingest(makeSnapshot(at(3), edited))
    expect(result).toMatchObject({ newMessages: 0, newVersions: 1, contentChanged: true })
    await ingest(makeSnapshot(at(4), edited))
    const versions = await withService(t.db, (tx) => tx<{ supersededAt: Date | null; text: string }[]>`
      select v.superseded_at, v.text from public.captured_message_versions v
      join public.captured_messages m on m.id = v.message_id
      where m.message_key = 'msg-0' order by v.captured_at`)
    expect(versions.map((v) => v.text)).toEqual(['Question number 0', 'Question number 0, reworded'])
    expect(versions[0]!.supersededAt).toEqual(new Date(at(3)))
    expect(versions[1]!.supersededAt).toBeNull()
    const [current] = await withService(t.db, (tx) => tx<{ text: string }[]>`
      select v.text from public.captured_messages m
      join public.captured_message_versions v on v.id = m.current_version_id
      where m.message_key = 'msg-0'`)
    expect(current?.text).toBe('Question number 0, reworded')
  })

  it('a signed-out page pauses capture and keeps the last good data', async () => {
    await ingest(makeSnapshot(at(0), thread(4)))
    const result = await ingest(makeSnapshot(at(2), [], { coverage: { pageState: 'signed_out' } }))
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'signed_out', captureState: 'signed_out' })
    expect(await count('captured_messages')).toBe(4)
    expect(await withService(t.db, (tx) => captureListSelection(tx))).toEqual([])
    expect(await ingest(makeSnapshot(at(3), thread(5)))).toEqual({
      status: 'not_active',
      captureState: 'signed_out',
    })
    // The owner resumes ("Reconnect"): capture continues from the stored state.
    await withOwner(t.db, owner, (tx) => captureSetConversationPaused(tx, conversationId, false))
    expect(await ingest(makeSnapshot(at(4), thread(5)))).toMatchObject({ newMessages: 1 })
  })

  it('an empty page is logged as ignored and changes nothing', async () => {
    await ingest(makeSnapshot(at(0), thread(2)))
    const result = await ingest(makeSnapshot(at(1), [], { coverage: { pageState: 'empty' } }))
    expect(result).toMatchObject({ outcome: 'ignored_partial', reason: 'empty_page', captureState: 'active' })
    expect(await count('captured_messages')).toBe(2)
  })

  it('concurrent uploads of the same content are idempotent', async () => {
    const messages = thread(20)
    const sameId = randomUUID()
    const uploads = [
      ...Array.from({ length: 4 }, () => makeSnapshot(at(0), messages, { snapshotId: sameId })),
      ...Array.from({ length: 4 }, () => makeSnapshot(at(0), messages)),
    ]
    const results = await Promise.all(uploads.map((s) => ingest(s)))
    expect(results.every((r) => r.status === 'ok')).toBe(true)
    const inserted = results.reduce((n, r) => n + (r.status === 'ok' && !r.duplicate ? r.newMessages : 0), 0)
    expect(inserted).toBe(20)
    expect(results.filter((r) => r.status === 'ok' && r.duplicate)).toHaveLength(3)
    expect(await count('captured_messages')).toBe(20)
    expect(await count('captured_message_versions')).toBe(20)
    expect(await count('capture_snapshots')).toBe(5)
    expect(await stored()).toEqual(await model([uploads[0]!]))
  })

  it('matches the pure reconcile model across out-of-order windows, edits and streaming', async () => {
    const full = thread(10)
    const snapshots = [
      makeSnapshot(at(4), full.slice(6), { coverage: { observedFirstMessage: false } }),
      makeSnapshot(at(1), full.slice(0, 4), { coverage: { observedLastMessage: false } }),
      makeSnapshot(at(6), [
        ...full.slice(8, 9),
        { ...full[9]!, text: 'Answer number 9, regenerated' },
      ], { coverage: { observedFirstMessage: false } }),
      makeSnapshot(at(2), full.slice(2, 8), {
        coverage: { observedFirstMessage: false, observedLastMessage: false },
      }),
      makeSnapshot(at(7), [...full.slice(8, 10), { key: 'msg-10', role: 'user', text: 'typing', isStreaming: true }], {
        coverage: { observedFirstMessage: false },
      }),
    ]
    for (const s of snapshots) await ingest(s)
    const expected = await model([...snapshots].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)))
    expect(await stored()).toEqual(expected)
    expect(expected.messages).toHaveLength(10)
  })
})

describe('selection and reported page states', () => {
  it('lists only active conversations with exactly the fields the helper needs', async () => {
    const claude = await withOwner(t.db, owner, (tx) => captureSelectConversation(tx, { url: CLAUDE_URL }))
    if (claude.status !== 'selected') throw new Error('select failed')
    await withOwner(t.db, owner, (tx) => captureSetConversationPaused(tx, claude.conversation.id, true))
    const selection = await withService(t.db, (tx) => captureListSelection(tx))
    expect(selection).toEqual([
      { id: conversationId, provider: 'chatgpt', externalId: CHAT_ID, url: CHAT_URL, captureState: 'active' },
    ])
  })

  it('marks problems, never overrides an owner pause, and ignores unselected conversations', async () => {
    const mark = (problem: 'signed_out' | 'challenge' | 'structure_changed', externalId = CHAT_ID) =>
      withService(t.db, (tx) =>
        captureMarkState(tx, { provider: 'chatgpt', externalId, problem, at: new Date(at(1)) }),
      )
    expect(await mark('challenge')).toEqual({ status: 'updated', captureState: 'needs_attention' })
    expect(await mark('challenge')).toEqual({ status: 'unchanged', captureState: 'needs_attention' })
    expect(await mark('structure_changed')).toEqual({ status: 'updated', captureState: 'structure_changed' })
    await withOwner(t.db, owner, (tx) => captureSetConversationPaused(tx, conversationId, true))
    expect(await mark('signed_out')).toEqual({ status: 'unchanged', captureState: 'paused' })
    expect(await mark('signed_out', '11111111-2222-4333-8444-555555555555')).toEqual({ status: 'not_selected' })
    expect(await mark('signed_out', 'not-a-uuid')).toEqual({ status: 'not_selected' })
  })

  it('re-selecting a conversation resumes it and can move it to another project', async () => {
    await withOwner(t.db, owner, (tx) => captureSetConversationPaused(tx, conversationId, true))
    const again = await withOwner(t.db, owner, (tx) =>
      captureSelectConversation(tx, { url: `${CHAT_URL}?model=x` }),
    )
    expect(again).toMatchObject({ status: 'selected', created: false, conversation: { captureState: 'active' } })
    expect(
      await withOwner(t.db, owner, (tx) =>
        captureSelectConversation(tx, { url: CHAT_URL, projectId: '11111111-2222-4333-8444-555555555555' }),
      ),
    ).toEqual({ status: 'unknown_project' })
    expect(
      await withOwner(t.db, owner, (tx) => captureSelectConversation(tx, { url: 'https://example.com/c/1' })),
    ).toEqual({ status: 'invalid_url' })
  })
})
