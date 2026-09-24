/**
 * Content-script runtime on SYNTHETIC pages: collects only selected
 * conversations, debounces DOM changes, waits for streaming to settle, and
 * reports signed-out / challenge / structure changes instead of sending empty
 * snapshots. The service worker is a fake that records messages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extractChatGPT } from '../src/content/extract-chatgpt.ts'
import { extractClaude } from '../src/content/extract-claude.ts'
import { RUNTIME_TIMING, startCaptureRuntime, type CaptureRuntime } from '../src/content/runtime.ts'
import type { ContentNotice, ContentRequest, HelloResponse } from '../src/shared/protocol.ts'
import { chatgptPage, chatgptSignedOutPage, gptThread, setScroll } from './fixtures/chatgpt.ts'
import { claudePage, claudeThread } from './fixtures/claude.ts'
import { CHAT_URL, CLAUDE_URL, pageWindow } from './helpers.ts'

type Win = ReturnType<typeof pageWindow>

interface Harness {
  win: Win
  runtime: CaptureRuntime
  sent: ContentRequest[]
  notify: (n: ContentNotice) => void
  hello: { value: HelloResponse }
}

let runtimes: CaptureRuntime[] = []

function start(html: string, url: string, provider: 'chatgpt' | 'claude', hello: HelloResponse): Harness {
  const win = pageWindow(html, url, 'Synthetic')
  const sent: ContentRequest[] = []
  const state = { value: hello }
  let listener: (n: ContentNotice) => void = () => {}
  let ids = 0
  const runtime = startCaptureRuntime({
    provider,
    extract: provider === 'chatgpt' ? extractChatGPT : extractClaude,
    send: async (m) => {
      sent.push(m)
      if (m.type === 'ph:hello') return state.value
      if (m.type === 'ph:observation') return { accepted: true, queued: 1 }
      return { ok: true }
    },
    onNotice: (l) => {
      listener = l
    },
    doc: win.document,
    win: win as unknown as Window,
    now: () => Date.now(),
    newId: () => `session-${++ids}`,
  })
  runtimes.push(runtime)
  return { win, runtime, sent, notify: (n) => listener(n), hello: state }
}

const observations = (h: Harness) => h.sent.filter((m) => m.type === 'ph:observation')
const problems = (h: Harness) => h.sent.filter((m) => m.type === 'ph:problem')
const settle = () => vi.advanceTimersByTimeAsync(RUNTIME_TIMING.settlePassiveMs + 50)

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-24T12:00:00Z') })
})
afterEach(() => {
  for (const r of runtimes) r.stop()
  runtimes = []
  vi.useRealTimers()
})

describe('content runtime', () => {
  it('collects a selected conversation once the page settles, then only on changes', async () => {
    const h = start(chatgptPage({ turns: gptThread(4) }), CHAT_URL, 'chatgpt', { collect: true, mode: 'passive' })
    await settle()
    expect(observations(h)).toHaveLength(1)
    const first = observations(h)[0] as Extract<ContentRequest, { type: 'ph:observation' }>
    expect(first.observation.messages.map((m) => m.text)).toEqual([
      'Synthetic message 0',
      'Synthetic message 1',
      'Synthetic message 2',
      'Synthetic message 3',
    ])
    expect(first.observation.url).toBe(CHAT_URL)

    // Unrelated re-render with the same content: nothing new is sent.
    h.win.document.body.innerHTML = chatgptPage({ turns: gptThread(4) })
    await settle()
    expect(observations(h)).toHaveLength(1)

    // A new reply arrives.
    h.win.document.body.innerHTML = chatgptPage({ turns: gptThread(6) })
    await settle()
    expect(observations(h)).toHaveLength(2)
    const second = observations(h)[1] as Extract<ContentRequest, { type: 'ph:observation' }>
    expect(second.observation.messages).toHaveLength(6)
    expect(second.observation.sessionId).toBe(first.observation.sessionId)
  })

  it('does nothing for an unselected conversation until the worker says to re-check', async () => {
    const h = start(chatgptPage({ turns: gptThread(2) }), CHAT_URL, 'chatgpt', {
      collect: false,
      mode: 'passive',
      reason: 'not_selected',
    })
    await settle()
    await vi.advanceTimersByTimeAsync(RUNTIME_TIMING.structureGraceMs + 1000)
    expect(observations(h)).toHaveLength(0)
    expect(problems(h)).toHaveLength(0)

    h.hello.value = { collect: true, mode: 'passive' }
    h.notify({ type: 'ph:recheck' })
    await settle()
    expect(observations(h)).toHaveLength(1)
  })

  it('never runs on pages that are not conversations', async () => {
    const h = start(chatgptPage({ turns: gptThread(2) }), 'https://chatgpt.com/', 'chatgpt', {
      collect: true,
      mode: 'passive',
    })
    await settle()
    expect(h.sent).toHaveLength(0)
  })

  it('waits for a streaming reply to finish before sending', async () => {
    const h = start(chatgptPage({ turns: gptThread(4), streaming: 'stop-button' }), CHAT_URL, 'chatgpt', {
      collect: true,
      mode: 'passive',
    })
    await settle()
    expect(observations(h)).toHaveLength(0)
    h.win.document.body.innerHTML = chatgptPage({ turns: gptThread(4) })
    await settle()
    expect(observations(h)).toHaveLength(1)
    const o = observations(h)[0] as Extract<ContentRequest, { type: 'ph:observation' }>
    expect(o.observation.streamingInProgress).toBe(false)
    expect(o.observation.messages.every((m) => !m.isStreaming)).toBe(true)
  })

  it('sends anyway after a long stream, with the unfinished reply flagged', async () => {
    const h = start(chatgptPage({ turns: gptThread(4), streaming: 'stop-button' }), CHAT_URL, 'chatgpt', {
      collect: true,
      mode: 'passive',
    })
    await vi.advanceTimersByTimeAsync(RUNTIME_TIMING.maxStreamingWaitMs + RUNTIME_TIMING.streamingRecheckMs * 2)
    const o = observations(h)[0] as Extract<ContentRequest, { type: 'ph:observation' }>
    expect(o.observation.streamingInProgress).toBe(true)
    expect(o.observation.messages[3]!.isStreaming).toBe(true)
  })

  it('reports structure_changed after the grace period instead of an empty snapshot', async () => {
    const h = start('<main><div data-scroll-root></div></main>', CHAT_URL, 'chatgpt', { collect: true, mode: 'passive' })
    await vi.advanceTimersByTimeAsync(RUNTIME_TIMING.structureGraceMs - 1000)
    expect(problems(h)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(problems(h)).toEqual([{ type: 'ph:problem', url: CHAT_URL, state: 'structure_changed' }])
    expect(observations(h)).toHaveLength(0)
    // It stops: no repeated reports.
    await vi.advanceTimersByTimeAsync(RUNTIME_TIMING.structureGraceMs * 2)
    expect(problems(h)).toHaveLength(1)
  })

  it('stops at a signed-out page and reports it', async () => {
    const h = start(chatgptSignedOutPage, CHAT_URL, 'chatgpt', { collect: true, mode: 'passive' })
    await settle()
    expect(problems(h)).toEqual([{ type: 'ph:problem', url: CHAT_URL, state: 'signed_out' }])
    expect(observations(h)).toHaveLength(0)
  })

  it('sends what it read before the page turned into a sign-in page, then reports it', async () => {
    const h = start(chatgptPage({ turns: gptThread(2) }), CHAT_URL, 'chatgpt', { collect: true, mode: 'passive' })
    await settle()
    h.win.document.body.innerHTML = chatgptPage({ turns: gptThread(4) })
    await vi.advanceTimersByTimeAsync(300)
    h.win.document.body.innerHTML = chatgptSignedOutPage
    await settle()
    const kinds = h.sent.filter((m) => m.type !== 'ph:hello').map((m) => m.type)
    expect(kinds).toEqual(['ph:observation', 'ph:observation', 'ph:problem'])
    expect((observations(h)[1] as Extract<ContentRequest, { type: 'ph:observation' }>).observation.messages).toHaveLength(4)
  })

  it('reports signed_out when the app navigates a collected conversation to its sign-in page', async () => {
    const h = start(claudePage({ rows: claudeThread(2) }), CLAUDE_URL, 'claude', { collect: true, mode: 'passive' })
    await settle()
    expect(observations(h)).toHaveLength(1)
    h.win.history.pushState({}, '', '/login')
    await h.runtime.checkLocation()
    expect(problems(h)).toEqual([{ type: 'ph:problem', url: CLAUDE_URL, state: 'signed_out' }])
  })

  it('starts a new session when the owner switches to another conversation', async () => {
    const h = start(chatgptPage({ turns: gptThread(2) }), CHAT_URL, 'chatgpt', { collect: true, mode: 'passive' })
    await settle()
    const other = 'https://chatgpt.com/c/1e2d3c4b-5a69-4788-9aab-bccddeeff001'
    h.win.history.pushState({}, '', new URL(other).pathname)
    h.win.document.body.innerHTML = chatgptPage({ turns: gptThread(3) })
    await h.runtime.checkLocation()
    await settle()
    const obs = observations(h) as Extract<ContentRequest, { type: 'ph:observation' }>[]
    expect(obs).toHaveLength(2)
    expect(obs[1]!.observation.url).toBe(other)
    expect(obs[1]!.observation.sessionId).not.toBe(obs[0]!.observation.sessionId)
    expect(obs[1]!.observation.messages).toHaveLength(3)
  })

  it('sends what it collected when the owner switches conversation before the page settled', async () => {
    const h = start(chatgptPage({ turns: gptThread(2) }), CHAT_URL, 'chatgpt', { collect: true, mode: 'passive' })
    await settle()
    expect(observations(h)).toHaveLength(1)
    // A new exchange renders; 800 ms later the owner clicks another chat in the sidebar.
    h.win.document.body.innerHTML = chatgptPage({ turns: gptThread(4) })
    await vi.advanceTimersByTimeAsync(800)
    const other = 'https://chatgpt.com/c/1e2d3c4b-5a69-4788-9aab-bccddeeff001'
    h.win.history.pushState({}, '', new URL(other).pathname)
    await h.runtime.checkLocation()
    h.win.document.body.innerHTML = chatgptPage({ turns: gptThread(3, (i) => `Other chat ${i}`) })
    await settle()
    const obs = observations(h) as Extract<ContentRequest, { type: 'ph:observation' }>[]
    const first = obs.filter((o) => o.observation.url === CHAT_URL)
    expect(first.at(-1)!.observation.messages.map((m) => m.text)).toEqual(
      gptThread(4).map((t) => t.messages[0]!.text),
    )
    // Nothing from the other conversation was merged into the first one.
    expect(first.flatMap((o) => o.observation.messages.map((m) => m.text)).some((t) => t.startsWith('Other chat'))).toBe(false)
    expect(obs.at(-1)!.observation).toMatchObject({ url: other })
  })

  it('sends what it collected when the tab is hidden or the page is left', async () => {
    const h = start(chatgptPage({ turns: gptThread(2) }), CHAT_URL, 'chatgpt', { collect: true, mode: 'passive' })
    await settle()
    h.win.document.body.innerHTML = chatgptPage({ turns: gptThread(4) })
    await vi.advanceTimersByTimeAsync(300)
    Object.defineProperty(h.win.document, 'visibilityState', { configurable: true, value: 'hidden' })
    h.win.document.dispatchEvent(new h.win.Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(observations(h)).toHaveLength(2)
    expect((observations(h)[1] as Extract<ContentRequest, { type: 'ph:observation' }>).observation.messages).toHaveLength(4)

    // Unsent changes are also sent when the page goes away; nothing is sent twice.
    h.win.document.body.innerHTML = chatgptPage({ turns: gptThread(6) })
    await vi.advanceTimersByTimeAsync(300)
    h.win.dispatchEvent(new h.win.Event('pagehide'))
    await vi.advanceTimersByTimeAsync(0)
    expect(observations(h)).toHaveLength(3)
    expect((observations(h)[2] as Extract<ContentRequest, { type: 'ph:observation' }>).observation.messages).toHaveLength(6)
    await settle()
    expect(observations(h)).toHaveLength(3)
  })

  it('never reads another conversation into this one when the app renders it before changing the URL', async () => {
    const h = start(chatgptPage({ turns: gptThread(2) }), CHAT_URL, 'chatgpt', { collect: true, mode: 'passive' })
    await settle()
    h.win.document.body.innerHTML = chatgptPage({
      turns: gptThread(3, (i) => `Other chat ${i}`).map((t, i) => ({
        ...t,
        turnId: `c${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`,
        messages: t.messages.map((m, j) => ({ ...m, id: `d${String(i * 10 + j).padStart(7, '0')}-0000-4000-8000-000000000000` })),
      })),
    })
    await vi.advanceTimersByTimeAsync(20)
    const other = 'https://chatgpt.com/c/1e2d3c4b-5a69-4788-9aab-bccddeeff001'
    h.win.history.pushState({}, '', new URL(other).pathname)
    await settle()
    const obs = observations(h) as Extract<ContentRequest, { type: 'ph:observation' }>[]
    for (const o of obs.filter((x) => x.observation.url === CHAT_URL)) {
      expect(o.observation.messages.some((m) => m.text.startsWith('Other chat'))).toBe(false)
    }
  })

  it('accumulates a virtualised thread across scroll positions', async () => {
    const rows = claudeThread(30)
    const h = start(claudePage({ rows, mounted: [24, 29] }), CLAUDE_URL, 'claude', { collect: true, mode: 'passive' })
    setScroll(h.win.document, '[data-autoscroll-container]', 'bottom')
    await settle()
    for (const [from, to] of [
      [12, 25],
      [0, 13],
    ] as const) {
      h.win.document.body.innerHTML = claudePage({ rows, mounted: [from, to] })
      setScroll(h.win.document, '[data-autoscroll-container]', from === 0 ? 'top' : 'middle')
      await settle()
    }
    const last = observations(h).at(-1) as Extract<ContentRequest, { type: 'ph:observation' }>
    expect(last.observation.messages).toHaveLength(30)
    expect(last.observation.observedFirstMessage).toBe(true)
  })

  it('collects every window while the owner scrolls steadily, without pausing on any of them', async () => {
    for (const every of [300, 500]) {
      const rows = claudeThread(60)
      const h = start(claudePage({ rows, mounted: [54, 59] }), CLAUDE_URL, 'claude', { collect: true, mode: 'passive' })
      setScroll(h.win.document, '[data-autoscroll-container]', 'bottom')
      await settle()
      // Up to the top and back down, a new 12-row window every `every` ms: never quiet for 1.5 s.
      const up = [44, 34, 24, 14, 4, 0]
      const down = [10, 20, 30, 40, 48]
      for (const from of [...up, ...down]) {
        h.win.document.body.innerHTML = claudePage({ rows, mounted: [from, from + 11] })
        setScroll(h.win.document, '[data-autoscroll-container]', from === 0 ? 'top' : from === 48 ? 'bottom' : 'middle')
        await vi.advanceTimersByTimeAsync(every)
      }
      await settle()
      const last = observations(h).at(-1) as Extract<ContentRequest, { type: 'ph:observation' }>
      expect(last.observation.messages).toHaveLength(60)
      expect(last.observation).toMatchObject({
        observedFirstMessage: true,
        observedLastMessage: true,
        contiguous: true,
        missingCount: 0,
      })
      h.runtime.stop()
    }
  })

  it('collects a ChatGPT thread scrolled through faster than the settle delay', async () => {
    const turns = gptThread(40)
    const h = start(chatgptPage({ turns, mounted: [34, 39] }), CHAT_URL, 'chatgpt', { collect: true, mode: 'passive' })
    setScroll(h.win.document, '[data-scroll-root]', 'bottom')
    await settle()
    for (const from of [28, 22, 16, 10, 4, 0]) {
      h.win.document.body.innerHTML = chatgptPage({ turns, mounted: [from, from + 7] })
      setScroll(h.win.document, '[data-scroll-root]', from === 0 ? 'top' : 'middle')
      await vi.advanceTimersByTimeAsync(400)
    }
    await settle()
    const last = observations(h).at(-1) as Extract<ContentRequest, { type: 'ph:observation' }>
    expect(last.observation.messages).toHaveLength(40)
    expect(last.observation).toMatchObject({ observedFirstMessage: true, contiguous: true })
    // One upload once the page settled, not one per window.
    expect(observations(h)).toHaveLength(2)
  })

  it('a jump to the top and back while scrolling fast still reports the gap', async () => {
    const rows = claudeThread(60)
    const h = start(claudePage({ rows, mounted: [54, 59] }), CLAUDE_URL, 'claude', { collect: true, mode: 'passive' })
    setScroll(h.win.document, '[data-autoscroll-container]', 'bottom')
    await settle()
    for (const [from, where] of [[0, 'top'], [48, 'bottom']] as const) {
      h.win.document.body.innerHTML = claudePage({ rows, mounted: [from, from + 11] })
      setScroll(h.win.document, '[data-autoscroll-container]', where)
      await vi.advanceTimersByTimeAsync(300)
    }
    await settle()
    const last = observations(h).at(-1) as Extract<ContentRequest, { type: 'ph:observation' }>
    expect(last.observation).toMatchObject({
      observedFirstMessage: true,
      observedLastMessage: true,
      contiguous: false,
      missingCount: 36,
    })
  })

  it('goes quiet when the extension is reloaded under it', async () => {
    const win = pageWindow(chatgptPage({ turns: gptThread(2) }), CHAT_URL)
    let calls = 0
    const runtime = startCaptureRuntime({
      provider: 'chatgpt',
      extract: extractChatGPT,
      send: async () => {
        calls++
        throw new Error('Extension context invalidated.')
      },
      onNotice: () => {},
      doc: win.document,
      win: win as unknown as Window,
      now: () => Date.now(),
      newId: () => 'x',
    })
    runtimes.push(runtime)
    await settle()
    win.document.body.innerHTML = chatgptPage({ turns: gptThread(4) })
    await settle()
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(1)
  })
})
