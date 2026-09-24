import { describe, expect, it } from 'vitest'
import {
  captureApplyOps,
  captureContentChanged,
  captureContentFingerprint,
  captureContentHash,
  capturePrepareSnapshot,
  captureReconcile,
  captureSortMessages,
  type CaptureCoverage,
  type CaptureReconcilePlan,
  type CaptureSnapshot,
  type CaptureStoredConversation,
} from '../src/index.ts'

const ID = '0b6a1f5e-9a3c-4c1e-8f2d-3a4b5c6d7e8f'
const EMPTY: CaptureStoredConversation = { messages: [] }
const RECEIVED = new Date('2030-01-01T00:00:00Z')
const T0 = Date.parse('2026-09-24T09:00:00.000Z')
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()

interface Msg {
  key?: string
  role: 'user' | 'assistant'
  text: string
  orderHint?: number
  isStreaming?: boolean
}

let snapshotSeq = 0
function snap(capturedAt: string, messages: Msg[], coverage: Partial<CaptureCoverage> = {}): CaptureSnapshot {
  snapshotSeq++
  return {
    schemaVersion: 1,
    snapshotId: `00000000-0000-4000-8000-${String(snapshotSeq).padStart(12, '0')}`,
    provider: 'chatgpt',
    conversation: { externalId: ID, url: `https://chatgpt.com/c/${ID}` },
    messages,
    capturedAt,
    coverage: {
      mode: 'passive',
      observedFirstMessage: true,
      observedLastMessage: true,
      renderedCount: messages.length,
      accumulatedCount: messages.length,
      streamingInProgress: messages.some((m) => m.isStreaming),
      pageState: 'ok',
      ...coverage,
    },
    extensionVersion: '0.1.0',
  }
}

async function step(
  state: CaptureStoredConversation,
  snapshot: CaptureSnapshot,
  receivedAt = RECEIVED,
): Promise<{ state: CaptureStoredConversation; plan: CaptureReconcilePlan }> {
  const prepared = await capturePrepareSnapshot(snapshot, { receivedAt })
  const plan = captureReconcile(state, prepared)
  return { state: captureApplyOps(state, plan.ops), plan }
}

async function applyAll(snapshots: CaptureSnapshot[], initial = EMPTY) {
  let state = initial
  for (const s of snapshots) state = (await step(state, s)).state
  return state
}

const keysOf = (s: CaptureStoredConversation) => captureSortMessages(s.messages).map((m) => m.key)
const msg = (s: CaptureStoredConversation, key: string) => s.messages.find((m) => m.key === key)!

describe('captureReconcile: basics', () => {
  it('inserts a new conversation with one current version per message', async () => {
    const { state, plan } = await step(
      EMPTY,
      snap(at(0), [
        { key: 'u1', role: 'user', text: 'Plan the week', orderHint: 1 },
        { key: 'a1', role: 'assistant', text: 'Here is a plan', orderHint: 2 },
      ]),
    )
    expect(plan.outcome).toBe('applied')
    expect(plan.complete).toBe(true)
    expect(plan.stats).toMatchObject({ newMessages: 2, newVersions: 0 })
    expect(plan.contentChanged).toBe(true)
    expect(keysOf(state)).toEqual(['u1', 'a1'])
    const a1 = msg(state, 'a1')
    expect(a1.versions).toHaveLength(1)
    expect(a1.currentHash).toBe(await captureContentHash('Here is a plan'))
    expect(a1.firstSeenAt).toBe(at(0))
    expect(a1.keySource).toBe('provider')
  })

  it('replaying the same snapshot produces no operations', async () => {
    const s = snap(at(0), [{ key: 'u1', role: 'user', text: 'hello', orderHint: 1 }])
    const first = await step(EMPTY, s)
    const again = await step(first.state, s)
    expect(again.plan.ops).toEqual([])
    expect(again.plan.contentChanged).toBe(false)
    expect(again.plan.stats.unchanged).toBe(1)
    expect(again.state).toEqual(first.state)
  })

  it('an edit creates exactly one new version; replays and older snapshots add none', async () => {
    const before = snap(at(0), [{ key: 'u1', role: 'user', text: 'Draft A', orderHint: 1 }])
    const after = snap(at(5), [{ key: 'u1', role: 'user', text: 'Draft B', orderHint: 1 }])
    const s1 = await step(EMPTY, before)
    const s2 = await step(s1.state, after)
    expect(s2.plan.ops.filter((o) => o.kind === 'insert_version')).toHaveLength(1)
    expect(s2.plan.stats.newVersions).toBe(1)
    expect(s2.plan.contentChanged).toBe(true)
    const u1 = msg(s2.state, 'u1')
    expect(u1.versions).toHaveLength(2)
    expect(u1.currentHash).toBe(await captureContentHash('Draft B'))
    const a = u1.versions.find((v) => v.contentHash !== u1.currentHash)!
    expect(a.supersededAt).toBe(at(5))

    const replay = await step(s2.state, after)
    expect(replay.plan.ops).toEqual([])
    const late = await step(replay.state, before) // the older upload arrives late
    expect(late.plan.stats.newVersions).toBe(0)
    expect(msg(late.state, 'u1').currentHash).toBe(await captureContentHash('Draft B'))
    expect(msg(late.state, 'u1').versions).toHaveLength(2)
  })

  it('switching back to an earlier branch makes that text current again without a new version', async () => {
    let state = await applyAll([
      snap(at(0), [{ key: 'a1', role: 'assistant', text: 'First answer', orderHint: 1 }]),
      snap(at(5), [{ key: 'a1', role: 'assistant', text: 'Regenerated', orderHint: 1 }]),
    ])
    const { state: next, plan } = await step(
      state,
      snap(at(9), [{ key: 'a1', role: 'assistant', text: 'First answer', orderHint: 1 }]),
    )
    state = next
    expect(plan.stats.newVersions).toBe(0)
    expect(plan.contentChanged).toBe(true)
    const a1 = msg(state, 'a1')
    expect(a1.currentHash).toBe(await captureContentHash('First answer'))
    const regenerated = a1.versions.find((v) => v.contentHash !== a1.currentHash)!
    expect(regenerated.supersededAt).toBe(at(9))
    expect(a1.versions.find((v) => v.contentHash === a1.currentHash)!.supersededAt).toBeNull()
  })

  it('ignores messages that are still streaming', async () => {
    const { state, plan } = await step(
      EMPTY,
      snap(at(0), [
        { key: 'u1', role: 'user', text: 'Question', orderHint: 1 },
        { key: 'a1', role: 'assistant', text: 'Partial ans', orderHint: 2, isStreaming: true },
      ]),
    )
    expect(plan.outcome).toBe('applied')
    expect(plan.complete).toBe(false)
    expect(plan.stats.ignoredStreaming).toBe(1)
    expect(keysOf(state)).toEqual(['u1'])

    const settled = await step(
      state,
      snap(at(1), [
        { key: 'u1', role: 'user', text: 'Question', orderHint: 1 },
        { key: 'a1', role: 'assistant', text: 'Partial answer, now complete.', orderHint: 2 },
      ]),
    )
    expect(keysOf(settled.state)).toEqual(['u1', 'a1'])
    expect(msg(settled.state, 'a1').versions).toHaveLength(1)

    const allStreaming = await step(
      EMPTY,
      snap(at(0), [{ key: 'a1', role: 'assistant', text: 'x', isStreaming: true }]),
    )
    expect(allStreaming.plan.outcome).toBe('ignored_partial')
    expect(allStreaming.plan.reason).toBe('no_settled_messages')
  })

  it.each([
    ['signed_out', 'rejected', 'signed_out'],
    ['challenge', 'rejected', 'needs_attention'],
    ['structure_changed', 'rejected', 'structure_changed'],
    ['empty', 'ignored_partial', null],
  ] as const)('pageState %s changes no messages', async (pageState, outcome, next) => {
    const stored = await applyAll([snap(at(0), [{ key: 'u1', role: 'user', text: 'keep me', orderHint: 1 }])])
    const { state, plan } = await step(stored, snap(at(1), [], { pageState }))
    expect(plan.outcome).toBe(outcome)
    expect(plan.nextCaptureState).toBe(next)
    expect(plan.ops).toEqual([])
    expect(state).toEqual(stored)
  })

  it('a partial page after a full capture never removes or supersedes missing messages', async () => {
    const full = Array.from({ length: 10 }, (_, i) => ({
      key: `m${i}`,
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `message ${i}`,
      orderHint: i,
    }))
    const stored = await applyAll([snap(at(0), full)])
    const { state, plan } = await step(
      stored,
      snap(at(3), full.slice(7), { observedFirstMessage: false, renderedCount: 3, accumulatedCount: 3 }),
    )
    expect(plan.complete).toBe(false)
    // Only seen-time, observation-time and order updates for the three overlapping messages.
    expect(
      plan.ops.every((o) => ['touch_message', 'observe_version', 'set_order'].includes(o.kind)),
    ).toBe(true)
    expect(new Set(plan.ops.map((o) => o.key))).toEqual(new Set(['m7', 'm8', 'm9']))
    expect(state.messages).toHaveLength(10)
    for (const m of state.messages) expect(m.versions.every((v) => v.supersededAt === null)).toBe(true)
    expect(plan.contentChanged).toBe(false)
  })

  it('ignores a role change for an existing key', async () => {
    const stored = await applyAll([snap(at(0), [{ key: 'x', role: 'user', text: 'hi', orderHint: 1 }])])
    const { state, plan } = await step(stored, snap(at(1), [{ key: 'x', role: 'assistant', text: 'hijack', orderHint: 1 }]))
    expect(plan.stats.roleConflicts).toBe(1)
    expect(state).toEqual(stored)
  })

  it('derives content keys when the page has no ids; identical texts get occurrence numbers', async () => {
    const { state } = await step(
      EMPTY,
      snap(at(0), [
        { role: 'user', text: 'ok', orderHint: 0 },
        { role: 'assistant', text: 'Sure', orderHint: 1 },
        { role: 'user', text: 'ok', orderHint: 2 },
      ]),
    )
    const keys = keysOf(state)
    expect(keys).toHaveLength(3)
    expect(keys[0]).toMatch(/^h:[0-9a-f]{32}:0$/)
    expect(keys[2]).toBe(keys[0]!.replace(/:0$/, ':1'))
    expect(state.messages.every((m) => m.keySource === 'derived')).toBe(true)
  })

  it('treats Claude position keys as derived and an edit at the same position as a new version', async () => {
    const s1 = await applyAll([
      snap(at(0), [{ key: 'd:0:user:0', role: 'user', text: 'v1', orderHint: 0 }]),
      snap(at(1), [{ key: 'd:0:user:0', role: 'user', text: 'v2 (edited)', orderHint: 0 }]),
    ])
    expect(s1.messages).toHaveLength(1)
    expect(s1.messages[0]!.keySource).toBe('derived')
    expect(s1.messages[0]!.versions).toHaveLength(2)
  })

  it('never trusts a capture time later than when the server received it', async () => {
    const received = new Date(at(10))
    const prepared = await capturePrepareSnapshot(
      snap(at(60 * 24 * 365), [{ key: 'u1', role: 'user', text: 'x', orderHint: 1 }]),
      { receivedAt: received },
    )
    expect(prepared.capturedAt).toBe(at(10))
  })

  it('only claims completeness with first and last observed, nothing streaming or omitted', async () => {
    const m = [{ key: 'u1', role: 'user' as const, text: 'x', orderHint: 1 }]
    expect((await step(EMPTY, snap(at(0), m))).plan.complete).toBe(true)
    expect((await step(EMPTY, snap(at(0), m, { observedFirstMessage: false }))).plan.complete).toBe(false)
    expect((await step(EMPTY, snap(at(0), m, { observedLastMessage: false }))).plan.complete).toBe(false)
    expect((await step(EMPTY, snap(at(0), m, { streamingInProgress: true }))).plan.complete).toBe(false)
    expect((await step(EMPTY, snap(at(0), m, { omittedCount: 2 }))).plan.complete).toBe(false)
  })

  it('drops empty messages (for example image-only turns) instead of storing blanks', async () => {
    const { state, plan } = await step(
      EMPTY,
      snap(at(0), [
        { key: 'u1', role: 'user', text: '   \n ', orderHint: 1 },
        { key: 'a1', role: 'assistant', text: 'answer', orderHint: 2 },
      ]),
    )
    expect(plan.stats.ignoredEmpty).toBe(1)
    expect(keysOf(state)).toEqual(['a1'])
  })
})

describe('captureReconcile: ordering', () => {
  it('orders by the page position hint, merging windows captured separately', async () => {
    const state = await applyAll([
      snap(at(0), [
        { key: 'm5', role: 'user', text: 'five', orderHint: 5 },
        { key: 'm6', role: 'assistant', text: 'six', orderHint: 6 },
      ]),
      snap(at(1), [
        { key: 'm1', role: 'user', text: 'one', orderHint: 1 },
        { key: 'm2', role: 'assistant', text: 'two', orderHint: 2 },
      ]),
      snap(at(2), [
        { key: 'm2', role: 'assistant', text: 'two', orderHint: 2 },
        { key: 'm3', role: 'user', text: 'three', orderHint: 3 },
      ]),
    ])
    expect(keysOf(state)).toEqual(['m1', 'm2', 'm3', 'm5', 'm6'])
  })

  it('places messages without a hint between their neighbours, never renaming anything', async () => {
    const stored = await applyAll([
      snap(at(0), [
        { key: 'a', role: 'user', text: 'a', orderHint: 10 },
        { key: 'c', role: 'user', text: 'c', orderHint: 20 },
      ]),
    ])
    const { state, plan } = await step(
      stored,
      snap(at(1), [
        { key: 'a', role: 'user', text: 'a' },
        { key: 'b1', role: 'assistant', text: 'b1' },
        { key: 'b2', role: 'assistant', text: 'b2' },
        { key: 'c', role: 'user', text: 'c' },
        { key: 'd', role: 'assistant', text: 'd' },
      ]),
    )
    expect(keysOf(state)).toEqual(['a', 'b1', 'b2', 'c', 'd'])
    expect(plan.ops.some((o) => o.kind === 'set_order')).toBe(false)
    const inserted = plan.ops.filter((o) => o.kind === 'insert_message')
    expect(inserted.every((o) => o.kind === 'insert_message' && o.orderObservedAt === null)).toBe(true)
  })

  it('an order-only change is not a content change', async () => {
    const stored = await applyAll([snap(at(0), [{ key: 'a', role: 'user', text: 'a', orderHint: 1 }])])
    const { plan } = await step(stored, snap(at(1), [{ key: 'a', role: 'user', text: 'a', orderHint: 4 }]))
    expect(plan.ops.map((o) => o.kind).sort()).toEqual([
      'observe_version',
      'set_order',
      'touch_message',
    ])
    expect(captureContentChanged(plan)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Property-style tests over randomly generated conversation histories
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface History {
  snapshots: CaptureSnapshot[]
  /** For each key: text shown by the latest (by capture time) snapshot that showed it settled. */
  latestText: Map<string, string>
  /** For each key: every distinct settled text any snapshot showed. */
  observedTexts: Map<string, Set<string>>
}

/**
 * A conversation evolves minute by minute (appends, edits, a streaming reply) and
 * the helper captures random windows of it, as a virtualised page would render them.
 */
function generateHistory(seed: number, steps = 14): History {
  const rand = mulberry32(seed)
  const pick = (n: number) => Math.floor(rand() * n)
  const convo: { key: string; role: 'user' | 'assistant'; text: string }[] = []
  const snapshots: CaptureSnapshot[] = []
  const latest = new Map<string, { t: string; text: string }>()
  const observedTexts = new Map<string, Set<string>>()
  let nextId = 0

  for (let s = 0; s < steps; s++) {
    const appends = convo.length === 0 ? 2 : pick(3)
    for (let i = 0; i < appends; i++) {
      const role = convo.length % 2 === 0 ? 'user' : 'assistant'
      convo.push({ key: `m${nextId++}`, role, text: `${role} ${nextId} r${pick(1000)}` })
    }
    if (convo.length > 0 && rand() < 0.4) {
      const target = convo[pick(convo.length)]!
      target.text = `${target.text} (edit ${s})`
    }
    const streamingLast = rand() < 0.25 && convo[convo.length - 1]!.role === 'assistant'
    const full = rand() < 0.3
    const start = full ? 0 : pick(convo.length)
    const end = full ? convo.length : Math.min(convo.length, start + 1 + pick(5))
    const t = at(s)
    const window = convo.slice(start, end).map((m, i) => {
      const index = start + i
      const streaming = streamingLast && index === convo.length - 1
      return {
        key: m.key,
        role: m.role,
        text: streaming ? m.text.slice(0, Math.max(1, m.text.length - 3)) : m.text,
        orderHint: index,
        ...(streaming ? { isStreaming: true } : {}),
      }
    })
    for (const m of window) {
      if (m.isStreaming) continue
      const prev = latest.get(m.key)
      if (!prev || prev.t <= t) latest.set(m.key, { t, text: m.text })
      if (!observedTexts.has(m.key)) observedTexts.set(m.key, new Set())
      observedTexts.get(m.key)!.add(m.text)
    }
    snapshots.push(
      snap(t, window, {
        observedFirstMessage: start === 0,
        observedLastMessage: end === convo.length,
      }),
    )
  }
  return {
    snapshots,
    latestText: new Map([...latest].map(([k, v]) => [k, v.text])),
    observedTexts,
  }
}

function shuffle<T>(items: T[], seed: number): T[] {
  const rand = mulberry32(seed)
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

const SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i * 7919)

describe('captureReconcile: properties', () => {
  it('replaying any snapshot is idempotent', async () => {
    for (const seed of SEEDS) {
      const { snapshots } = generateHistory(seed)
      let state = EMPTY
      for (const s of snapshots) {
        state = (await step(state, s)).state
        const replay = await step(state, s)
        expect(replay.plan.ops, `seed ${seed}`).toEqual([])
        expect(replay.state).toEqual(state)
      }
    }
  })

  it('out-of-order and duplicated deliveries converge to the same state', async () => {
    for (const seed of SEEDS) {
      const { snapshots } = generateHistory(seed)
      const inOrder = await applyAll(snapshots)
      const shuffled = await applyAll(shuffle(snapshots, seed + 1))
      const reversed = await applyAll([...snapshots].reverse())
      const duplicated = await applyAll(shuffle([...snapshots, ...snapshots.slice(0, 5)], seed + 2))
      expect(shuffled, `seed ${seed}`).toEqual(inOrder)
      expect(reversed, `seed ${seed}`).toEqual(inOrder)
      expect(duplicated, `seed ${seed}`).toEqual(inOrder)
      expect(captureContentFingerprint(shuffled)).toBe(captureContentFingerprint(inOrder))
    }
  })

  it('never loses data: stored messages and versions only grow, whatever arrives', async () => {
    for (const seed of SEEDS) {
      const { snapshots } = generateHistory(seed)
      let state = EMPTY
      for (const s of shuffle(snapshots, seed + 3)) {
        const before = new Set(state.messages.flatMap((m) => m.versions.map((v) => `${m.key}/${v.contentHash}`)))
        const { state: next, plan } = await step(state, s)
        const after = new Set(next.messages.flatMap((m) => m.versions.map((v) => `${m.key}/${v.contentHash}`)))
        for (const x of before) expect(after.has(x), `seed ${seed}`).toBe(true)
        expect(next.messages.length).toBeGreaterThanOrEqual(state.messages.length)
        expect(plan.stats.newMessages).toBe(next.messages.length - state.messages.length)
        state = next
      }
    }
  })

  it('keeps one version per distinct observed text and the latest observed text as current', async () => {
    for (const seed of SEEDS) {
      const { snapshots, latestText, observedTexts } = generateHistory(seed)
      const state = await applyAll(shuffle(snapshots, seed + 4))
      expect(state.messages.map((m) => m.key).sort()).toEqual([...latestText.keys()].sort())
      for (const m of state.messages) {
        expect(m.versions).toHaveLength(observedTexts.get(m.key)!.size)
        expect(m.currentHash).toBe(await captureContentHash(latestText.get(m.key)!))
        expect(m.versions.filter((v) => v.supersededAt === null)).toHaveLength(1)
      }
      // The final order follows the conversation's own positions.
      const order = keysOf(state).map((k) => Number(k.slice(1)))
      expect(order).toEqual([...order].sort((a, b) => a - b))
    }
  })
})
