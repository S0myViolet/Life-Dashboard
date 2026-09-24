/**
 * Plain-language capture state and coverage copy (pure; no database).
 */
import { describe, expect, it } from 'vitest'
import { CAPTURE_STATES } from '@personal-home/core'
import {
  CAPTURE_STATE_COPY,
  captureConversationLabel,
  captureCoverageSummary,
  captureRelativeTime,
  captureResumeLabel,
} from '@/lib/capture/view'

const at = (iso: string) => new Date(iso)

describe('capture state copy', () => {
  it('covers every state, and problem states say Reconnect / Capture needs attention', () => {
    for (const s of CAPTURE_STATES) expect(CAPTURE_STATE_COPY[s].label.length).toBeGreaterThan(0)
    expect(CAPTURE_STATE_COPY.signed_out.label).toBe('Reconnect')
    expect(CAPTURE_STATE_COPY.needs_attention.label).toBe('Capture needs attention')
    expect(CAPTURE_STATE_COPY.structure_changed.label).toBe('Capture needs attention')
    expect(captureResumeLabel('paused')).toBe('Resume')
    expect(captureResumeLabel('signed_out')).toBe('Reconnect')
  })
})

describe('captureCoverageSummary', () => {
  it('never claims anything was collected before the first capture', () => {
    expect(
      captureCoverageSummary({
        messageCount: 0,
        lastCapturedAt: null,
        lastSeenCompleteAt: null,
        lastSnapshot: null,
      }),
    ).toMatch(/^Nothing collected yet/)
  })

  it('never claims every message when the first and last were seen with a gap between them', () => {
    const gapped = captureCoverageSummary({
      messageCount: 12,
      lastCapturedAt: at('2026-09-24T10:00:00Z'),
      lastSeenCompleteAt: null,
      lastSnapshot: {
        outcome: 'applied',
        reason: null,
        mode: 'passive',
        coverage: { observedFirstMessage: true, observedLastMessage: true, contiguous: false, missingCount: 48 },
      },
    })
    expect(gapped).toContain('12 messages saved')
    expect(gapped).toContain('some messages between the first and the last were never in view (48 turns not seen)')
    expect(gapped).toContain('No capture has seen every message')
    expect(gapped).not.toMatch(/saw (the whole conversation|every message)/)

    // Older helpers that did not report gaps: the gap is not ruled out.
    const legacy = captureCoverageSummary({
      messageCount: 12,
      lastCapturedAt: at('2026-09-24T10:00:00Z'),
      lastSeenCompleteAt: null,
      lastSnapshot: {
        outcome: 'applied',
        reason: null,
        mode: 'passive',
        coverage: { observedFirstMessage: true, observedLastMessage: true },
      },
    })
    expect(legacy).toContain('some messages between the first and the last were never in view;')
  })

  it('claims the whole conversation only when the latest capture saw first to last', () => {
    const complete = captureCoverageSummary({
      messageCount: 12,
      lastCapturedAt: at('2026-09-24T10:00:00Z'),
      lastSeenCompleteAt: at('2026-09-24T10:00:00Z'),
      lastSnapshot: null,
    })
    expect(complete).toContain('12 messages saved')
    expect(complete).toContain('saw every message from the first to the last')

    const partial = captureCoverageSummary({
      messageCount: 40,
      lastCapturedAt: at('2026-09-24T11:00:00Z'),
      lastSeenCompleteAt: at('2026-09-24T10:00:00Z'),
      lastSnapshot: {
        outcome: 'applied',
        reason: null,
        mode: 'passive',
        coverage: { observedFirstMessage: false, observedLastMessage: true, streamingInProgress: true },
      },
    })
    expect(partial).toContain('40 messages saved')
    expect(partial).toContain('the start was not in view')
    expect(partial).toContain('still being written')
    expect(partial).not.toContain('saw every message')

    const never = captureCoverageSummary({
      messageCount: 1,
      lastCapturedAt: at('2026-09-24T11:00:00Z'),
      lastSeenCompleteAt: null,
      lastSnapshot: null,
    })
    expect(never).toContain('1 message saved')
    expect(never).toContain('No capture has seen every message from the first to the last yet')
  })
})

describe('labels and times', () => {
  it('falls back to the provider and a short id when there is no title', () => {
    expect(
      captureConversationLabel({ title: '  ', provider: 'claude', externalId: '5d1c0e2f-7b8a-4c3d-9e0f-1a2b3c4d5e6f' }),
    ).toBe('Claude conversation 5d1c0e2f')
    expect(captureConversationLabel({ title: 'Plan', provider: 'chatgpt', externalId: 'x' })).toBe('Plan')
  })

  it('formats relative times and switches to a local date after a week', () => {
    const now = at('2026-09-24T12:00:00Z')
    expect(captureRelativeTime(at('2026-09-24T11:59:30Z'), now, 'Europe/London')).toBe('just now')
    expect(captureRelativeTime(at('2026-09-24T11:55:00Z'), now, 'Europe/London')).toBe('5 minutes ago')
    expect(captureRelativeTime(at('2026-09-23T12:00:00Z'), now, 'Europe/London')).toBe('yesterday')
    expect(captureRelativeTime(at('2026-09-01T08:00:00Z'), now, 'Europe/London')).toContain('2026')
  })
})
