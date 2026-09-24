/**
 * Payload building respects the capture endpoint's hard limits and always
 * produces bodies the endpoint's own schema accepts. Messages are synthetic.
 */
import { describe, expect, it } from 'vitest'
import { CAPTURE_LIMITS, CaptureSnapshotSchema, captureCoverageIsComplete } from '@personal-home/core'
import type { ObservedMessage, PageObservation } from '../src/shared/protocol.ts'
import { buildSnapshots, snapshotBodyBytes } from '../src/shared/snapshot.ts'
import { CHAT_ID, CHAT_URL } from './helpers.ts'

let n = 0
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

function observation(messages: ObservedMessage[], extra: Partial<PageObservation> = {}): PageObservation {
  return {
    url: CHAT_URL,
    title: 'Synthetic',
    sessionId: 'sess',
    capturedAt: '2026-09-24T12:00:00.000Z',
    messages,
    observedFirstMessage: true,
    observedLastMessage: true,
    contiguous: true,
    missingCount: 0,
    renderedCount: messages.length,
    streamingInProgress: false,
    ...extra,
  }
}

const msgs = (count: number, size = 20): ObservedMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    key: `k${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `${i}:`.padEnd(size, 'x'),
    orderHint: i,
    isStreaming: false,
  }))

const build = (obs: PageObservation, extra: { maxBodyBytes?: number; maxMessages?: number } = {}) =>
  buildSnapshots({
    provider: 'chatgpt',
    externalId: CHAT_ID,
    canonicalUrl: CHAT_URL,
    observation: obs,
    mode: 'passive',
    extensionVersion: '0.1.0',
    newId,
    ...extra,
  })

describe('buildSnapshots', () => {
  it('builds one schema-valid, complete snapshot for a small page', () => {
    const { snapshots, oversized } = build(observation(msgs(4)))
    expect(oversized).toBe(0)
    expect(snapshots).toHaveLength(1)
    const s = CaptureSnapshotSchema.parse(snapshots[0])
    expect(s.messages).toHaveLength(4)
    expect(captureCoverageIsComplete(s.coverage)).toBe(true)
    expect(s.coverage).toMatchObject({ accumulatedCount: 4, renderedCount: 4, mode: 'passive' })
  })

  it('never reports a complete page when messages between the first and last were not seen', () => {
    for (const gap of [{ contiguous: false, missingCount: 28 }, { contiguous: false }] as const) {
      const [s] = build(observation(msgs(12), gap)).snapshots
      expect(s!.coverage).toMatchObject({ observedFirstMessage: true, observedLastMessage: true, ...gap })
      expect(captureCoverageIsComplete(CaptureSnapshotSchema.parse(s).coverage)).toBe(false)
    }
  })

  it('splits more than 2000 messages into chunks that each admit they are partial', () => {
    const { snapshots } = build(observation(msgs(4500)))
    expect(snapshots.map((s) => s.messages.length)).toEqual([2000, 2000, 500])
    for (const s of snapshots) {
      CaptureSnapshotSchema.parse(s)
      expect(captureCoverageIsComplete(s.coverage)).toBe(false)
      expect(s.coverage.omittedCount).toBe(4500 - s.messages.length)
    }
    expect(snapshots[0]!.coverage.observedFirstMessage).toBe(true)
    expect(snapshots[0]!.coverage.observedLastMessage).toBe(false)
    expect(snapshots[2]!.coverage.observedLastMessage).toBe(true)
    expect(new Set(snapshots.map((s) => s.snapshotId)).size).toBe(3)
  })

  it('keeps every body under 2 MB by splitting on size', () => {
    const { snapshots } = build(observation(msgs(30, 150_000)))
    expect(snapshots.length).toBeGreaterThan(1)
    for (const s of snapshots) {
      expect(snapshotBodyBytes(s)).toBeLessThanOrEqual(CAPTURE_LIMITS.maxPayloadBytes)
      CaptureSnapshotSchema.parse(s)
    }
    expect(snapshots.reduce((n, s) => n + s.messages.length, 0)).toBe(30)
  })

  it('counts UTF-8 bytes, not characters', () => {
    const wide: ObservedMessage[] = Array.from({ length: 12 }, (_, i) => ({
      key: `w${i}`,
      role: 'assistant',
      text: '😀'.repeat(50_000), // 100k UTF-16 units, 200 KB of UTF-8
      isStreaming: false,
    }))
    const { snapshots } = build(observation(wide))
    for (const s of snapshots) expect(snapshotBodyBytes(s)).toBeLessThanOrEqual(CAPTURE_LIMITS.maxPayloadBytes)
  })

  it('leaves out (never truncates) a message over 200,000 characters and says so', () => {
    const list = msgs(3)
    list[1] = { ...list[1]!, text: 'y'.repeat(CAPTURE_LIMITS.maxMessageChars + 1) }
    const { snapshots, oversized } = build(observation(list))
    expect(oversized).toBe(1)
    const s = CaptureSnapshotSchema.parse(snapshots[0])
    expect(s.messages.map((m) => m.key)).toEqual(['k0', 'k2'])
    expect(s.coverage.omittedCount).toBe(1)
    expect(captureCoverageIsComplete(s.coverage)).toBe(false)
  })

  it('drops keys the endpoint would reject and passes streaming flags through', () => {
    const list: ObservedMessage[] = [
      { key: 'bad key with spaces', role: 'user', text: 'a', isStreaming: false },
      { key: 'ok-key', role: 'assistant', text: 'b', isStreaming: true },
    ]
    const s = CaptureSnapshotSchema.parse(build(observation(list, { streamingInProgress: true })).snapshots[0])
    expect(s.messages[0]!.key).toBeUndefined()
    expect(s.messages[1]).toMatchObject({ key: 'ok-key', isStreaming: true })
    expect(s.coverage.streamingInProgress).toBe(true)
  })

  it('cleans the title and caps it', () => {
    const s = build(observation(msgs(1), { title: `  ${'T'.repeat(800)}\n` })).snapshots[0]!
    expect(s.conversation.title).toHaveLength(CAPTURE_LIMITS.maxTitleChars)
    const none = build(observation(msgs(1), { title: '   ' })).snapshots[0]!
    expect(none.conversation.title).toBeUndefined()
  })
})
