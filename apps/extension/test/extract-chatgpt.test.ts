/**
 * ChatGPT extractor against SYNTHETIC DOM fixtures (test/fixtures/chatgpt.ts),
 * shaped from docs/research/chat-dom.md. Not captured from the live service.
 */
import { describe, expect, it } from 'vitest'
import { extractChatGPT } from '../src/content/extract-chatgpt.ts'
import {
  challengePage,
  chatgptPage,
  chatgptSignedOutPage,
  gptMessageId,
  gptThread,
  gptTurnId,
  setScroll,
  type GptTurn,
} from './fixtures/chatgpt.ts'
import { CHAT_URL, pageDocument } from './helpers.ts'

const doc = (html: string, url = CHAT_URL, title = 'Trip planning') => pageDocument(html, url, title)

describe('extractChatGPT', () => {
  it('reads roles, message ids, text and turn order; skips sr-only headings and buttons', () => {
    const d = doc(chatgptPage({ turns: gptThread(4) }))
    setScroll(d, '[data-scroll-root]', 'top')
    const x = extractChatGPT(d)
    expect(x.status).toBe('ok')
    expect(x.messages.map((m) => [m.key, m.role, m.text, m.orderHint])).toEqual([
      [gptMessageId(1), 'user', 'Synthetic message 0', 1],
      [gptMessageId(2), 'assistant', 'Synthetic message 1', 2],
      [gptMessageId(3), 'user', 'Synthetic message 2', 3],
      [gptMessageId(4), 'assistant', 'Synthetic message 3', 4],
    ])
    for (const m of x.messages) {
      expect(m.text).not.toMatch(/said:|Copy|Edit/)
      expect(m.isStreaming).toBe(false)
    }
    expect(x.title).toBe('Trip planning')
    expect(x.streaming).toBe(false)
  })

  it('keeps markdown structure as line breaks and ignores code-block buttons', () => {
    const turns: GptTurn[] = [
      {
        ordinal: 1,
        role: 'assistant',
        turnId: gptTurnId(1),
        messages: [
          {
            id: gptMessageId(1),
            text: '',
            html: '<h3>Plan</h3><ul><li>One</li><li>Two</li></ul><pre><div><span>bash</span><button>Copy code</button></div><code>ls -la</code></pre>',
          },
        ],
      },
    ]
    const x = extractChatGPT(doc(chatgptPage({ turns })))
    expect(x.messages[0]!.text).toBe('Plan\nOne\nTwo\nbash\nls -la')
  })

  it('splits an assistant turn with several message elements, keyed by message id', () => {
    const turns: GptTurn[] = [
      {
        ordinal: 7,
        role: 'assistant',
        turnId: gptTurnId(7),
        messages: [
          { id: gptMessageId(71), text: 'First part' },
          { id: gptMessageId(72), text: 'Second part' },
        ],
      },
    ]
    const x = extractChatGPT(doc(chatgptPage({ turns })))
    expect(x.messages.map((m) => [m.key, m.orderHint])).toEqual([
      [gptMessageId(71), 7],
      [gptMessageId(72), 7.01],
    ])
  })

  it('keys on data-turn-id when a message has no id, and stores nothing for image-only turns', () => {
    const turns: GptTurn[] = [
      { ordinal: 1, role: 'user', turnId: gptTurnId(1), messages: [{ text: 'Draw a cat' }] },
      { ordinal: 2, role: 'assistant', turnId: gptTurnId(2), messages: [], imageOnly: true },
    ]
    const x = extractChatGPT(doc(chatgptPage({ turns })))
    expect(x.messages[0]!.key).toBe(gptTurnId(1))
    const image = x.messages.find((m) => m.role === 'assistant')!
    expect(image.key).toBe(gptTurnId(2))
    expect(image.text).toBe('') // attachments/images are never claimed as text
  })

  it('an edited prompt is a different branch: new message ids, so a new key', () => {
    const before = extractChatGPT(doc(chatgptPage({ turns: gptThread(2) })))
    const edited = gptThread(2, (i) => (i === 0 ? 'Edited prompt' : 'New reply'))
    edited[0]!.messages[0]!.id = gptMessageId(901)
    edited[1]!.messages[0]!.id = gptMessageId(902)
    const after = extractChatGPT(doc(chatgptPage({ turns: edited })))
    expect(after.messages[0]!.key).not.toBe(before.messages[0]!.key)
    expect(after.messages[0]!.orderHint).toBe(before.messages[0]!.orderHint)
  })

  it('flags the last assistant message while the stop button is shown', () => {
    const x = extractChatGPT(doc(chatgptPage({ turns: gptThread(4), streaming: 'stop-button' })))
    expect(x.streaming).toBe(true)
    expect(x.messages.map((m) => m.isStreaming)).toEqual([false, false, false, true])
  })

  it('never flags an older, finished reply while the owner has scrolled up during a stream', () => {
    // Turns 0-8 of 20 mounted at the top; the reply being written (turn 19) is not mounted.
    const d = doc(chatgptPage({ turns: gptThread(20), mounted: [0, 8], streaming: 'stop-button' }))
    setScroll(d, '[data-scroll-root]', 'top')
    const x = extractChatGPT(d)
    expect(x.streaming).toBe(true)
    expect(x.messages.filter((m) => m.isStreaming)).toEqual([])

    // The prompt was just sent and its reply turn does not exist yet: the previous reply is finished.
    const sent = doc(chatgptPage({ turns: gptThread(5), streaming: 'stop-button' }))
    setScroll(sent, '[data-scroll-root]', 'bottom')
    expect(extractChatGPT(sent).messages.filter((m) => m.isStreaming)).toEqual([])

    // Without persistent wrappers the end is only known at the bottom of the scroller.
    const old = doc(chatgptPage({ turns: gptThread(10), mounted: [4, 9], streaming: 'stop-button', noWrappers: true }))
    setScroll(old, '[data-scroll-root]', 'middle')
    expect(extractChatGPT(old).messages.filter((m) => m.isStreaming)).toEqual([])
    setScroll(old, '[data-scroll-root]', 'bottom')
    expect(extractChatGPT(old).messages.filter((m) => m.isStreaming).map((m) => m.key)).toEqual([gptMessageId(10)])
  })

  it('flags the message whose markdown carries the streaming class', () => {
    const x = extractChatGPT(doc(chatgptPage({ turns: gptThread(4), streaming: 'class' })))
    expect(x.streaming).toBe(true)
    expect(x.messages.filter((m) => m.isStreaming).map((m) => m.key)).toEqual([gptMessageId(4)])
  })

  it('does not mistake sidebar titles or dictation buttons for a stop button', () => {
    const x = extractChatGPT(doc(chatgptPage({ turns: gptThread(2) })))
    expect(x.streaming).toBe(false)
  })

  it('claims first/last only when that end is mounted with text and the scroller is there', () => {
    const turns = gptThread(30)
    const top = doc(chatgptPage({ turns, mounted: [0, 8] }))
    setScroll(top, '[data-scroll-root]', 'top')
    expect(extractChatGPT(top)).toMatchObject({ firstMounted: true, lastMounted: false })

    const middle = doc(chatgptPage({ turns, mounted: [12, 18] }))
    setScroll(middle, '[data-scroll-root]', 'middle')
    expect(extractChatGPT(middle)).toMatchObject({ firstMounted: false, lastMounted: false })

    const bottom = doc(chatgptPage({ turns, mounted: [24, 29] }))
    setScroll(bottom, '[data-scroll-root]', 'bottom')
    expect(extractChatGPT(bottom)).toMatchObject({ firstMounted: false, lastMounted: true })

    // At the top but the first wrapper has not hydrated yet: not observed.
    const hydrating = doc(chatgptPage({ turns, mounted: [1, 8] }))
    setScroll(hydrating, '[data-scroll-root]', 'top')
    expect(extractChatGPT(hydrating).firstMounted).toBe(false)
  })

  it('never claims coverage without the scroller', () => {
    const d = doc(chatgptPage({ turns: gptThread(2) }).replace('data-scroll-root', 'data-other'))
    expect(extractChatGPT(d)).toMatchObject({ status: 'ok', firstMounted: false, lastMounted: false })
  })

  it('still reads messages when turn containers are renamed (message elements as turns)', () => {
    const html = chatgptPage({ turns: gptThread(2), noWrappers: true })
      .replace(/data-testid="conversation-turn-\d+"/g, '')
      .replace(/data-turn="\w+"/g, '')
    const x = extractChatGPT(doc(html))
    expect(x.status).toBe('ok')
    expect(x.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(x.messages[0]!.orderHint).toBeUndefined()
  })

  it('reports structure_changed when turn containers exist but no message can be recognised', () => {
    const html = chatgptPage({ turns: gptThread(2) })
      .replace(/data-message-author-role="\w+"/g, 'data-author="x"')
      .replace(/data-turn="\w+"/g, 'data-turn="unknown"')
    expect(extractChatGPT(doc(html)).status).toBe('structure_changed')
  })

  it('reports loading (not an empty conversation) while nothing is rendered', () => {
    const x = extractChatGPT(doc('<main><div data-scroll-root></div></main>'))
    expect(x).toMatchObject({ status: 'loading', messages: [] })
  })

  it('detects a signed-out page and a verification challenge', () => {
    expect(extractChatGPT(doc(chatgptSignedOutPage)).status).toBe('signed_out')
    expect(extractChatGPT(doc('<main></main>', 'https://chatgpt.com/auth/login')).status).toBe('signed_out')
    expect(extractChatGPT(doc(challengePage, CHAT_URL, 'Just a moment...')).status).toBe('challenge')
  })

  it('ignores an invisible challenge widget on a page that renders the conversation', () => {
    const d = doc(chatgptPage({ turns: gptThread(2) }) + challengePage)
    expect(extractChatGPT(d).status).toBe('ok')
  })
})
