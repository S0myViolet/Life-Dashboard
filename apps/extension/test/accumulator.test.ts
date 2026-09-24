/**
 * Virtualised threads: both apps mount only a window of turns. These tests
 * replay SYNTHETIC mount/unmount sequences (scrolling up and back down) and
 * check that the accumulator keeps everything it saw, in order, with honest
 * coverage. Fixtures are shaped from docs/research/chat-dom.md (ADR-017
 * measurements), not captured from the live services.
 */
import { describe, expect, it } from 'vitest'
import { CaptureAccumulator } from '../src/content/accumulator.ts'
import { extractChatGPT } from '../src/content/extract-chatgpt.ts'
import { extractClaude } from '../src/content/extract-claude.ts'
import { chatgptPage, gptMessageId, gptThread, setScroll } from './fixtures/chatgpt.ts'
import { claudePage, claudeThread } from './fixtures/claude.ts'
import { CHAT_URL, CLAUDE_URL, pageDocument, rerender } from './helpers.ts'

const NOW = new Date('2026-09-24T12:00:00Z')

describe('CaptureAccumulator with a virtualised ChatGPT thread', () => {
  const turns = gptThread(40)
  const d = pageDocument('', CHAT_URL, 'Long thread')
  const show = (mounted: [number, number], where: 'top' | 'middle' | 'bottom') => {
    rerender(d, chatgptPage({ turns, mounted }))
    setScroll(d, '[data-scroll-root]', where)
    return extractChatGPT(d)
  }

  it('collects every window while the owner scrolls up and back down', () => {
    const acc = new CaptureAccumulator(CHAT_URL, 'session-1')
    // Opened cold at the bottom: only the last turns are mounted.
    expect(acc.observe(show([34, 39], 'bottom'))).toBe(true)
    let obs = acc.toObservation(NOW)!
    expect(obs.messages).toHaveLength(6)
    expect(obs).toMatchObject({ observedFirstMessage: false, observedLastMessage: true, renderedCount: 6 })

    // Scrolling up mounts older windows and unmounts newer ones.
    acc.observe(show([24, 35], 'middle'))
    acc.observe(show([12, 25], 'middle'))
    acc.observe(show([0, 13], 'top'))
    obs = acc.toObservation(NOW)!
    expect(obs.observedFirstMessage).toBe(true)
    expect(obs.observedLastMessage).toBe(false) // the latest view is at the top
    expect(obs.messages).toHaveLength(40)
    expect(obs.messages.map((m) => m.key)).toEqual(turns.map((t) => t.messages[0]!.id))

    // Back to the bottom: earlier windows are evicted from the DOM but kept here.
    acc.observe(show([34, 39], 'bottom'))
    obs = acc.toObservation(NOW)!
    expect(obs.messages).toHaveLength(40)
    expect(obs).toMatchObject({ observedFirstMessage: true, observedLastMessage: true, renderedCount: 6 })
  })

  it('never claims the first message when the top was not reached', () => {
    const acc = new CaptureAccumulator(CHAT_URL, 'session-2')
    acc.observe(show([34, 39], 'bottom'))
    acc.observe(show([20, 35], 'middle'))
    expect(acc.toObservation(NOW)!.observedFirstMessage).toBe(false)
    expect(acc.toObservation(NOW)!.messages).toHaveLength(20)
  })

  it('reports no change when the same window is observed again', () => {
    const acc = new CaptureAccumulator(CHAT_URL, 'session-3')
    acc.observe(show([34, 39], 'bottom'))
    acc.markSent()
    expect(acc.observe(show([34, 39], 'bottom'))).toBe(false)
    expect(acc.hasUnsent).toBe(false)
  })

  it('holds a streaming reply until it settles, then takes the final text', () => {
    const acc = new CaptureAccumulator(CHAT_URL, 'session-4')
    const live = gptThread(4, (i) => (i === 3 ? 'Partial' : `Synthetic message ${i}`))
    rerender(d, chatgptPage({ turns: live, streaming: 'stop-button' }))
    setScroll(d, '[data-scroll-root]', 'bottom')
    acc.observe(extractChatGPT(d))
    expect(acc.isStreaming).toBe(true)
    expect(acc.toObservation(NOW)!.messages[3]).toMatchObject({ text: 'Partial', isStreaming: true })

    rerender(d, chatgptPage({ turns: gptThread(4, (i) => (i === 3 ? 'Final answer' : `Synthetic message ${i}`)) }))
    setScroll(d, '[data-scroll-root]', 'bottom')
    expect(acc.observe(extractChatGPT(d))).toBe(true)
    expect(acc.isStreaming).toBe(false)
    expect(acc.toObservation(NOW)!.messages[3]).toMatchObject({
      key: gptMessageId(4),
      text: 'Final answer',
      isStreaming: false,
    })
  })

  it('drops a stale streaming flag on a message that is no longer mounted once the stream is over', () => {
    const acc = new CaptureAccumulator(CHAT_URL, 'session-stale')
    const msg = (n: number, isStreaming = false) => ({
      key: gptMessageId(n),
      localKey: gptMessageId(n),
      role: 'assistant' as const,
      text: `Synthetic message ${n}`,
      orderHint: n,
      isStreaming,
    })
    const base = { status: 'ok' as const, firstMounted: false, renderedPositions: [], threadPositions: null }
    // Scrolled up while a reply streams: a mounted message was flagged.
    acc.observe({ ...base, messages: [msg(7), msg(8, true)], lastMounted: false, streaming: true })
    expect(acc.isStreaming).toBe(true)
    // Still scrolled up, the stream ended: the page cannot tell yet (the end is not in view).
    acc.observe({ ...base, messages: [msg(1), msg(2)], lastMounted: false, streaming: false })
    expect(acc.isStreaming).toBe(true)
    // Back at the end with nothing streaming: message 8 is not being written.
    acc.observe({ ...base, messages: [msg(19), msg(20)], lastMounted: true, streaming: false })
    expect(acc.isStreaming).toBe(false)
    const obs = acc.toObservation(NOW)!
    expect(obs.streamingInProgress).toBe(false)
    expect(obs.messages.find((m) => m.key === gptMessageId(8))).toMatchObject({ isStreaming: false })
  })

  it('an older reply is never held as streaming after the owner scrolls up during a stream', () => {
    const acc = new CaptureAccumulator(CHAT_URL, 'session-scrolled-up')
    const long = gptThread(20)
    rerender(d, chatgptPage({ turns: long, mounted: [0, 8], streaming: 'stop-button' }))
    setScroll(d, '[data-scroll-root]', 'top')
    acc.observe(extractChatGPT(d))
    expect(acc.toObservation(NOW)!.messages.filter((m) => m.isStreaming)).toEqual([])
    rerender(d, chatgptPage({ turns: long, mounted: [14, 19] }))
    setScroll(d, '[data-scroll-root]', 'bottom')
    acc.observe(extractChatGPT(d))
    expect(acc.toObservation(NOW)!.streamingInProgress).toBe(false)
  })

  it('keeps both branches when an edited prompt replaces a turn (never deletes)', () => {
    const acc = new CaptureAccumulator(CHAT_URL, 'session-5')
    rerender(d, chatgptPage({ turns: gptThread(2) }))
    acc.observe(extractChatGPT(d))
    const edited = gptThread(2, (i) => (i === 0 ? 'Edited prompt' : 'New reply'))
    edited[0]!.messages[0]!.id = gptMessageId(901)
    edited[1]!.messages[0]!.id = gptMessageId(902)
    rerender(d, chatgptPage({ turns: edited }))
    acc.observe(extractChatGPT(d))
    const keys = acc.toObservation(NOW)!.messages.map((m) => m.key)
    expect(keys).toHaveLength(4)
    expect(keys).toEqual(expect.arrayContaining([gptMessageId(1), gptMessageId(901)]))
  })

  it('ignores turns whose body has not hydrated yet instead of storing blanks', () => {
    const acc = new CaptureAccumulator(CHAT_URL, 'session-6')
    const blank = gptThread(2, (i) => (i === 1 ? '' : 'Hello'))
    rerender(d, chatgptPage({ turns: blank }))
    acc.observe(extractChatGPT(d))
    expect(acc.toObservation(NOW)!.messages.map((m) => m.text)).toEqual(['Hello'])
  })
})

describe('CaptureAccumulator with a virtualised Claude thread', () => {
  const rows = claudeThread(56)
  const d = pageDocument('', CLAUDE_URL, 'Research - Claude')
  const show = (mounted: [number, number], where: 'top' | 'middle' | 'bottom', changed = rows) => {
    rerender(d, claudePage({ rows: changed, mounted }))
    setScroll(d, '[data-autoscroll-container]', where)
    return extractClaude(d)
  }

  it('merges windows of [data-index] rows into one ordered thread', () => {
    const acc = new CaptureAccumulator(CLAUDE_URL, 's1')
    acc.observe(show([50, 55], 'bottom')) // 6 of 56 rows rendered cold
    acc.observe(show([40, 51], 'middle'))
    acc.observe(show([20, 41], 'middle'))
    acc.observe(show([0, 21], 'top'))
    const obs = acc.toObservation(NOW)!
    expect(obs.messages.map((m) => m.orderHint)).toEqual(rows.map((r) => r.index))
    expect(obs.observedFirstMessage).toBe(true)
    expect(obs.observedLastMessage).toBe(false)
  })

  it('an edit seen while scrolling updates the same key (a new version server-side)', () => {
    const acc = new CaptureAccumulator(CLAUDE_URL, 's2')
    acc.observe(show([50, 55], 'bottom'))
    acc.markSent()
    const edited = rows.map((r) => (r.index === 52 ? { ...r, text: 'Edited question' } : r))
    expect(acc.observe(show([50, 55], 'bottom', edited))).toBe(true)
    const m = acc.toObservation(NOW)!.messages.find((x) => x.key === 'd:52:user:0')!
    expect(m.text).toBe('Edited question')
    expect(acc.size).toBe(6)
  })

  it('does not accumulate anything from a non-ok extract', () => {
    const acc = new CaptureAccumulator(CLAUDE_URL, 's3')
    rerender(d, '<div data-autoscroll-container></div>')
    expect(acc.observe(extractClaude(d))).toBe(false)
    expect(acc.toObservation(NOW)).toBeNull()
  })
})
