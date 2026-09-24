/**
 * Revisit prototype planning (pure): bounded queue, one collector per service,
 * blocking on sign-in pages, and navigation classification.
 */
import { describe, expect, it } from 'vitest'
import type { CaptureSelectionItem } from '@personal-home/core'
import {
  REVISIT,
  blockProvider,
  classifyCollectorNavigation,
  emptyRevisitState,
  expiredCollectors,
  finishCollector,
  nextToOpen,
  planRevisits,
  startCollector,
  unblockProvider,
} from '../src/shared/revisit.ts'

const sel = (i: number, provider: 'chatgpt' | 'claude', state: CaptureSelectionItem['captureState'] = 'active'): CaptureSelectionItem => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  provider,
  externalId: `11111111-0000-4000-8000-${String(i).padStart(12, '0')}`,
  url: provider === 'chatgpt' ? `https://chatgpt.com/c/x${i}` : `https://claude.ai/chat/x${i}`,
  captureState: state,
})

const T0 = 10 * REVISIT.intervalMs

describe('planRevisits', () => {
  it('queues only active, stale, unblocked conversations, bounded', () => {
    const selection = [sel(1, 'chatgpt'), sel(2, 'chatgpt'), sel(3, 'claude'), sel(4, 'claude', 'paused')]
    const recentlyCaptured = { [selection[1]!.id]: T0 - 60_000 }
    const s = planRevisits(emptyRevisitState(), selection, recentlyCaptured, T0)
    expect(s.queue.map((t) => t.conversationId)).toEqual([selection[0]!.id, selection[2]!.id])

    const many = Array.from({ length: 50 }, (_, i) => sel(100 + i, 'chatgpt'))
    expect(planRevisits(emptyRevisitState(), many, {}, T0).queue).toHaveLength(REVISIT.maxQueue)
  })

  it('opens at most one collector tab per service', () => {
    const selection = [sel(1, 'chatgpt'), sel(2, 'chatgpt'), sel(3, 'claude'), sel(4, 'claude')]
    let s = planRevisits(emptyRevisitState(), selection, {}, T0)
    const first = nextToOpen(s)
    expect(first.map((t) => t.provider).sort()).toEqual(['chatgpt', 'claude'])
    s = startCollector(s, first[0]!, 11, T0)
    s = startCollector(s, first[1]!, 12, T0)
    expect(nextToOpen(s)).toEqual([])
    s = finishCollector(s, 11)
    expect(nextToOpen(s).map((t) => t.provider)).toEqual([first[0]!.provider])
    // A conversation just visited is not queued again within the interval.
    expect(planRevisits(s, selection, {}, T0 + 60_000).queue).toHaveLength(2)
  })

  it('expires collectors after the timeout', () => {
    const s = startCollector(emptyRevisitState(), { conversationId: 'c', provider: 'claude', url: 'u', queuedAt: 0 }, 5, T0)
    expect(expiredCollectors(s, T0 + REVISIT.tabTimeoutMs - 1)).toHaveLength(0)
    expect(expiredCollectors(s, T0 + REVISIT.tabTimeoutMs)).toHaveLength(1)
  })

  it('a blocked service gets nothing queued or opened until resumed', () => {
    const selection = [sel(1, 'chatgpt'), sel(2, 'claude')]
    let s = planRevisits(emptyRevisitState(), selection, {}, T0)
    s = blockProvider(s, 'chatgpt', 'signed_out', T0)
    expect(s.queue.map((t) => t.provider)).toEqual(['claude'])
    expect(nextToOpen(planRevisits(s, selection, {}, T0)).map((t) => t.provider)).toEqual(['claude'])
    s = unblockProvider(s, 'chatgpt')
    expect(planRevisits(s, selection, {}, T0).queue.map((t) => t.provider).sort()).toEqual(['chatgpt', 'claude'])
  })
})

describe('classifyCollectorNavigation', () => {
  it('recognises sign-in redirects and leaving the site', () => {
    expect(classifyCollectorNavigation('chatgpt', 'https://chatgpt.com/c/abc')).toBe('ok')
    expect(classifyCollectorNavigation('chatgpt', 'https://chatgpt.com/auth/login')).toBe('signed_out')
    expect(classifyCollectorNavigation('chatgpt', 'https://auth.openai.com/log-in')).toBe('signed_out')
    // Chrome hides the URL of hosts the helper has no access to.
    expect(classifyCollectorNavigation('chatgpt', undefined)).toBe('signed_out')
    expect(classifyCollectorNavigation('claude', 'https://claude.ai/login?returnTo=/chat/x')).toBe('signed_out')
    expect(classifyCollectorNavigation('claude', 'https://claude.ai/chat/abc')).toBe('ok')
  })
})
