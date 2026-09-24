/**
 * Coverage must never claim the whole conversation unless every message
 * between the first and the last was actually seen during the page visit.
 * Both apps virtualise long threads: jumping from the bottom to the top (Home
 * key, dragging the scrollbar) and back mounts only those two windows and never
 * the middle. SYNTHETIC fixtures shaped from docs/research/chat-dom.md.
 */
import { describe, expect, it } from 'vitest'
import { captureCoverageIsComplete, capturePrepareSnapshot } from '@personal-home/core'
import { CaptureAccumulator } from '../src/content/accumulator.ts'
import { extractChatGPT } from '../src/content/extract-chatgpt.ts'
import { extractClaude } from '../src/content/extract-claude.ts'
import type { PageObservation } from '../src/shared/protocol.ts'
import { buildSnapshots } from '../src/shared/snapshot.ts'
import { chatgptPage, gptThread, setScroll, type GptTurn } from './fixtures/chatgpt.ts'
import { claudePage, claudeThread, type ClaudeRow } from './fixtures/claude.ts'
import { CHAT_ID, CHAT_URL, CLAUDE_ID, CLAUDE_URL, pageDocument, rerender } from './helpers.ts'

const NOW = new Date('2026-09-24T12:00:00Z')
type Where = 'top' | 'middle' | 'bottom'

let ids = 0
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`

/** What the server would conclude from this observation (the full helper → endpoint path). */
async function serverSaysComplete(obs: PageObservation, provider: 'chatgpt' | 'claude'): Promise<boolean> {
  const { snapshots } = buildSnapshots({
    provider,
    externalId: provider === 'chatgpt' ? CHAT_ID : CLAUDE_ID,
    canonicalUrl: provider === 'chatgpt' ? CHAT_URL : CLAUDE_URL,
    observation: obs,
    mode: 'passive',
    extensionVersion: '0.1.0',
    newId,
  })
  expect(snapshots).toHaveLength(1)
  const prepared = await capturePrepareSnapshot(snapshots[0]!, { receivedAt: NOW })
  return captureCoverageIsComplete(snapshots[0]!.coverage) && prepared.complete
}

function gpt(turns: GptTurn[], options: { noWrappers?: boolean } = {}) {
  const d = pageDocument('', CHAT_URL, 'Long thread')
  return (mounted: [number, number], where: Where) => {
    rerender(d, chatgptPage({ turns, mounted, ...options }))
    setScroll(d, '[data-scroll-root]', where)
    return extractChatGPT(d)
  }
}

function claude(rows: ClaudeRow[], options: { setsize?: number | null } = {}) {
  const d = pageDocument('', CLAUDE_URL, 'Research - Claude')
  return (mounted: [number, number], where: Where, changed = rows) => {
    rerender(d, claudePage({ rows: changed, mounted, ...options }))
    setScroll(d, '[data-autoscroll-container]', where)
    return extractClaude(d)
  }
}

describe('coverage on a virtualised ChatGPT thread', () => {
  const turns = gptThread(40)

  it('a jump to the top and back is not the whole conversation', async () => {
    const show = gpt(turns)
    const acc = new CaptureAccumulator(CHAT_URL, 'jump')
    acc.observe(show([34, 39], 'bottom')) // opened cold at the bottom
    acc.observe(show([0, 5], 'top')) // Home key: only the top window mounts
    acc.observe(show([34, 39], 'bottom')) // End key
    const obs = acc.toObservation(NOW)!
    expect(obs.messages).toHaveLength(12)
    expect(obs).toMatchObject({ observedFirstMessage: true, observedLastMessage: true })
    expect(obs.contiguous).toBe(false)
    expect(obs.missingCount).toBe(28)
    expect(await serverSaysComplete(obs, 'chatgpt')).toBe(false)
  })

  it('scrolling through every window proves the thread has no gaps', async () => {
    const show = gpt(turns)
    const acc = new CaptureAccumulator(CHAT_URL, 'scroll')
    acc.observe(show([34, 39], 'bottom'))
    acc.observe(show([24, 35], 'middle'))
    acc.observe(show([12, 25], 'middle'))
    acc.observe(show([0, 13], 'top'))
    let obs = acc.toObservation(NOW)!
    expect(obs.contiguous).toBe(true)
    expect(obs.observedLastMessage).toBe(false) // still at the top
    expect(await serverSaysComplete(obs, 'chatgpt')).toBe(false)

    acc.observe(show([34, 39], 'bottom'))
    obs = acc.toObservation(NOW)!
    expect(obs).toMatchObject({ observedFirstMessage: true, observedLastMessage: true, contiguous: true, missingCount: 0 })
    expect(await serverSaysComplete(obs, 'chatgpt')).toBe(true)
  })

  it('a new turn that arrives later is a gap until it has rendered', () => {
    const show = gpt(turns)
    const acc = new CaptureAccumulator(CHAT_URL, 'grow')
    acc.observe(show([0, 39], 'bottom'))
    expect(acc.toObservation(NOW)!.contiguous).toBe(true)
    // Two more turns exist (wrappers) but the owner is scrolled up and they are unmounted.
    const longer = gpt(gptThread(42))
    acc.observe(longer([0, 20], 'top'))
    expect(acc.toObservation(NOW)!).toMatchObject({ contiguous: false, missingCount: 2 })
  })

  it('without persistent wrappers, only a single view of the whole thread proves it', () => {
    const acc = new CaptureAccumulator(CHAT_URL, 'old-dom')
    const show = gpt(gptThread(30), { noWrappers: true })
    acc.observe(show([24, 29], 'bottom'))
    acc.observe(show([0, 5], 'top'))
    acc.observe(show([24, 29], 'bottom'))
    expect(acc.toObservation(NOW)!.contiguous).toBe(false)

    const all = new CaptureAccumulator(CHAT_URL, 'old-dom-all')
    const short = gpt(gptThread(6), { noWrappers: true })
    all.observe(short([0, 5], 'bottom'))
    // A short thread fits one view: the top of the scroller is the top of the thread.
    const d = pageDocument(chatgptPage({ turns: gptThread(6), noWrappers: true }), CHAT_URL)
    const scroller = d.querySelector('[data-scroll-root]')!
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 800 })
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 900 })
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 0 })
    all.observe(extractChatGPT(d))
    expect(all.toObservation(NOW)!).toMatchObject({ observedFirstMessage: true, observedLastMessage: true, contiguous: true })
  })

  it('an image-only turn in the middle does not block coverage once it has rendered', () => {
    const withImage = gptThread(6)
    withImage[3] = { ordinal: 4, role: 'assistant', turnId: withImage[3]!.turnId, messages: [], imageOnly: true }
    const show = gpt(withImage)
    const acc = new CaptureAccumulator(CHAT_URL, 'image')
    acc.observe(show([0, 5], 'bottom'))
    const obs = acc.toObservation(NOW)!
    expect(obs.messages).toHaveLength(5) // the image is not text and is not collected
    expect(obs.contiguous).toBe(true)
  })

  it('a turn shell with only an icon action bar is not counted as seen', () => {
    const d = pageDocument(chatgptPage({ turns: gptThread(4) }), CHAT_URL)
    setScroll(d, '[data-scroll-root]', 'bottom')
    const shell = d.querySelectorAll('[data-testid^="conversation-turn-"]')[1]!
    shell.querySelector('[data-message-author-role]')!.remove()
    shell.insertAdjacentHTML('beforeend', '<button aria-label="Copy"><svg viewBox="0 0 1 1"></svg><img alt="" src="data:,"></button>')
    const acc = new CaptureAccumulator(CHAT_URL, 'shell')
    acc.observe(extractChatGPT(d))
    expect(acc.toObservation(NOW)!).toMatchObject({ contiguous: false, missingCount: 1 })
  })

  it('a turn that has not hydrated yet is not counted as seen', () => {
    const blank = gptThread(4, (i) => (i === 1 ? '' : `Synthetic message ${i}`))
    const acc = new CaptureAccumulator(CHAT_URL, 'hydrate')
    acc.observe(gpt(blank)([0, 3], 'bottom'))
    expect(acc.toObservation(NOW)!).toMatchObject({ contiguous: false, missingCount: 1 })
    acc.observe(gpt(gptThread(4))([0, 3], 'bottom'))
    expect(acc.toObservation(NOW)!).toMatchObject({ contiguous: true, missingCount: 0 })
  })
})

describe('coverage on a virtualised Claude thread', () => {
  const rows = claudeThread(60)
  /** Overlapping windows from the bottom to the top (starts of 12-row windows). */
  const UPWARD = [44, 34, 24, 14, 4, 0]

  it('a jump to the top and back is not the whole conversation', async () => {
    const show = claude(rows)
    const acc = new CaptureAccumulator(CLAUDE_URL, 'jump')
    acc.observe(show([54, 59], 'bottom'))
    acc.observe(show([0, 5], 'top'))
    acc.observe(show([54, 59], 'bottom'))
    const obs = acc.toObservation(NOW)!
    expect(obs.messages).toHaveLength(12)
    expect(obs).toMatchObject({ observedFirstMessage: true, observedLastMessage: true })
    expect(obs.contiguous).toBe(false)
    expect(obs.missingCount).toBe(48)
    expect(await serverSaysComplete(obs, 'claude')).toBe(false)
  })

  it('scrolling through every window proves the thread has no gaps', async () => {
    const show = claude(rows)
    const acc = new CaptureAccumulator(CLAUDE_URL, 'scroll')
    acc.observe(show([54, 59], 'bottom'))
    for (const from of UPWARD) acc.observe(show([from, from + 11], from === 0 ? 'top' : 'middle'))
    acc.observe(show([54, 59], 'bottom'))
    const obs = acc.toObservation(NOW)!
    expect(obs.messages).toHaveLength(60)
    expect(obs).toMatchObject({ contiguous: true, missingCount: 0 })
    expect(await serverSaysComplete(obs, 'claude')).toBe(true)
  })

  it('without aria-setsize, the rows up to the mounted last row are the outline', () => {
    const show = claude(rows, { setsize: null })
    const jump = new CaptureAccumulator(CLAUDE_URL, 'no-setsize-jump')
    jump.observe(show([54, 59], 'bottom'))
    jump.observe(show([0, 5], 'top'))
    jump.observe(show([54, 59], 'bottom'))
    expect(jump.toObservation(NOW)!).toMatchObject({ contiguous: false, missingCount: 48 })

    const scrolled = new CaptureAccumulator(CLAUDE_URL, 'no-setsize-scroll')
    for (let from = 50; from >= 0; from -= 10) scrolled.observe(show([from, Math.min(59, from + 11)], 'middle'))
    // The end was never mounted at the bottom in this visit: the outline is unknown.
    expect(scrolled.toObservation(NOW)!.contiguous).toBe(false)
    scrolled.observe(show([50, 59], 'bottom'))
    expect(scrolled.toObservation(NOW)!).toMatchObject({ contiguous: true, missingCount: 0 })
  })

  it('an attachment-only row in the middle does not block coverage once it has rendered', () => {
    const withAttachment: ClaudeRow[] = claudeThread(6).map((r) =>
      r.index === 2 ? { index: 2, role: 'attachment', text: '' } : r,
    )
    const acc = new CaptureAccumulator(CLAUDE_URL, 'attachment')
    acc.observe(claude(withAttachment)([0, 5], 'bottom'))
    const obs = acc.toObservation(NOW)!
    expect(obs.messages).toHaveLength(5)
    expect(obs.contiguous).toBe(true)
  })

  it('an edited row makes rows that are not mounted count as unseen again', () => {
    const show = claude(rows)
    const acc = new CaptureAccumulator(CLAUDE_URL, 'edit')
    acc.observe(show([54, 59], 'bottom'))
    for (const from of UPWARD) acc.observe(show([from, from + 11], from === 0 ? 'top' : 'middle'))
    expect(acc.toObservation(NOW)!.contiguous).toBe(true)
    // A branch switch on row 4 replaces what Claude shows below it; rows 12+ are not mounted.
    const switched = rows.map((r) => (r.index >= 4 ? { ...r, text: `${r.text} (other branch)` } : r))
    acc.observe(show([0, 11], 'top', switched))
    expect(acc.toObservation(NOW)!).toMatchObject({ contiguous: false, missingCount: 48 })
  })
})
