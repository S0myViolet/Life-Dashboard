// SYNTHETIC FIXTURE (not captured from the live service).
// Shaped from docs/research/chat-dom.md: 2026 ChatGPT turns are <section
// data-testid="conversation-turn-N" data-turn=... data-turn-id=...> inside persistent
// [data-turn-id-container] wrappers (empty while unmounted), messages are
// [data-message-author-role][data-message-id], content is .markdown.prose /
// .whitespace-pre-wrap, sr-only "You said:" / "ChatGPT said:" headings, a
// [data-scroll-root] scroller, a sidebar <nav> with overflow classes, and the
// stop button [data-testid="stop-button"] while a reply streams.

export interface GptMessage {
  id?: string
  text: string
  /** Raw inner HTML for the content root (defaults to <p>text</p>). */
  html?: string
}

export interface GptTurn {
  ordinal: number
  role: 'user' | 'assistant'
  turnId: string
  messages: GptMessage[]
  /** Image-generation turn: no message element, no markdown. */
  imageOnly?: boolean
}

export interface GptPageOptions {
  turns: GptTurn[]
  /** Indexes into `turns` that are mounted (default: all). Others render as empty wrappers. */
  mounted?: [number, number]
  streaming?: 'stop-button' | 'class' | null
  title?: string
  /** Old DOM without persistent wrappers. */
  noWrappers?: boolean
}

const uuid = (n: number, prefix = '0') =>
  `${prefix.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`

export const gptMessageId = (n: number) => uuid(n, 'a')
export const gptTurnId = (n: number) => uuid(n, 'b')

/** A thread of alternating user/assistant turns, one message each. */
export function gptThread(count: number, text = (i: number) => `Synthetic message ${i}`): GptTurn[] {
  return Array.from({ length: count }, (_, i) => ({
    ordinal: i + 1,
    role: i % 2 === 0 ? 'user' : 'assistant',
    turnId: gptTurnId(i + 1),
    messages: [{ id: gptMessageId(i + 1), text: text(i) }],
  }))
}

function messageHtml(role: 'user' | 'assistant', m: GptMessage, streamingClass: boolean): string {
  const idAttr = m.id ? ` data-message-id="${m.id}"` : ''
  const body = m.html ?? `<p>${m.text}</p>`
  if (role === 'user') {
    return `<div data-message-author-role="user"${idAttr}>
      <div class="user-message-bubble-color"><div class="whitespace-pre-wrap">${m.html ?? m.text}</div></div>
      <button aria-label="Edit message">Edit</button>
    </div>`
  }
  return `<div data-message-author-role="assistant"${idAttr} data-message-model-slug="gpt-5-2">
    <div class="markdown prose dark:prose-invert w-full break-words light markdown-new-styling${streamingClass ? ' result-streaming' : ''}">${body}</div>
  </div>`
}

function turnHtml(t: GptTurn, streamingClass: boolean): string {
  const heading =
    t.role === 'user' ? '<h5 class="sr-only">You said:</h5>' : '<h6 class="sr-only">ChatGPT said:</h6>'
  const inner = t.imageOnly
    ? '<div class="image-gen"><img src="data:," alt="Generated image"></div>'
    : t.messages.map((m) => messageHtml(t.role, m, streamingClass)).join('')
  return `<section data-testid="conversation-turn-${t.ordinal}" data-turn="${t.role}" data-turn-id="${t.turnId}">
    ${heading}
    ${inner}
    <div class="actions"><button data-testid="copy-turn-action-button" aria-label="Copy">Copy</button></div>
  </section>`
}

export function chatgptPage(o: GptPageOptions): string {
  const [from, to] = o.mounted ?? [0, o.turns.length - 1]
  const lastAssistant = o.turns.map((t) => t.role).lastIndexOf('assistant')
  const body = o.turns
    .map((t, i) => {
      const mounted = i >= from && i <= to
      const content = mounted ? turnHtml(t, o.streaming === 'class' && i === lastAssistant) : ''
      if (o.noWrappers) return content
      const height = mounted ? '' : ' style="--last-known-height: 480px"'
      return `<div data-turn-id-container="${t.turnId}"${height}>${content}</div>`
    })
    .join('\n')
  const composer =
    o.streaming === 'stop-button'
      ? '<button data-testid="stop-button" aria-label="Stop streaming"></button>'
      : '<button data-testid="send-button" aria-label="Send prompt"></button>'
  return `
    <nav class="flex-1 flex-col overflow-y-auto">
      <a href="/c/11111111-1111-4111-8111-111111111111">6 Train Not Stopping</a>
      <button aria-label="Stop sharing">…</button>
    </nav>
    <main>
      <div data-scroll-root class="not-print:overflow-y-auto">
        <div class="thread">${body}</div>
      </div>
      <form>${composer}<button aria-label="Start dictation">mic</button></form>
    </main>`
}

/** Signed-out landing page (synthetic): login buttons, no thread. */
export const chatgptSignedOutPage = `
  <main>
    <h1>What can I help with?</h1>
    <button data-testid="login-button">Log in</button>
    <button data-testid="signup-button">Sign up for free</button>
  </main>`

/** Cloudflare interstitial (synthetic): only the hidden Turnstile response input is visible. */
export const challengePage = `
  <div id="challenge-running">Verifying you are human…</div>
  <input type="hidden" id="cf-chl-widget-abc12_response" name="cf-turnstile-response">`

/** Position the scroller: 'top', 'middle' or 'bottom' of a tall thread. */
export function setScroll(doc: Document, selector: string, where: 'top' | 'middle' | 'bottom'): void {
  const el = doc.querySelector(selector)
  if (!el) throw new Error(`no ${selector}`)
  const scrollHeight = 20_000
  const clientHeight = 900
  const scrollTop = where === 'top' ? 0 : where === 'bottom' ? scrollHeight - clientHeight : 8_000
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
  Object.defineProperty(el, 'scrollTop', { configurable: true, value: scrollTop, writable: true })
}
