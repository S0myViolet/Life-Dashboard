// SYNTHETIC FIXTURE (not captured from the live service).
// Shaped from docs/research/chat-dom.md: the thread scroller is the only
// [data-autoscroll-container]; each message is a monotonic [data-index] row
// (turns wrapped in div[data-test-render-count]); user text is
// [data-testid="user-message"]; replies are .font-claude-response with
// data-is-streaming on the same element or an ancestor; markdown is
// .standard-markdown when done and .standard-markdown nested inside
// .progressive-markdown while streaming; attachment-only user rows have no
// user-message node; Deep Research artifacts use #markdown-artifact; the
// redesigned sidebar (dframe-nav-scroll) shares the scroller's classes.
// Where aria-setsize sits is not documented; this fixture puts it on rows.

export interface ClaudeRow {
  index: number
  role: 'user' | 'assistant' | 'attachment'
  text: string
  streaming?: boolean
  /** Put data-is-streaming on a wrapper instead of the response element. */
  streamingOnAncestor?: boolean
  html?: string
  artifact?: string
}

export interface ClaudePageOptions {
  rows: ClaudeRow[]
  /** Indexes into `rows` that are mounted (default all). Unmounted rows are absent (virtualised). */
  mounted?: [number, number]
  setsize?: number | null
  title?: string
  noScroller?: boolean
}

export function claudeThread(count: number, text = (i: number) => `Synthetic Claude message ${i}`): ClaudeRow[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: text(i),
  }))
}

function rowHtml(r: ClaudeRow, setsize: number | null): string {
  const size = setsize === null ? '' : ` aria-setsize="${setsize}" aria-posinset="${r.index + 1}"`
  let inner: string
  if (r.role === 'user') {
    inner = `<div class="group relative bg-neutral-30 rounded-xl"><div data-testid="user-message"><p class="whitespace-pre-wrap break-words">${r.html ?? r.text}</p></div></div>
      <div role="group"><button data-testid="action-bar-edit" aria-label="Edit">Edit</button>
      <button aria-label="Previous version">‹</button><span>1 / 2</span></div>`
  } else if (r.role === 'attachment') {
    inner = `<div class="attachment-thumbnail"><img alt="report.pdf" src="data:,"><span>report.pdf</span></div>`
  } else {
    const flag = r.streaming ? 'true' : 'false'
    const markdown = r.streaming
      ? `<div class="progressive-markdown"><div class="standard-markdown">${r.html ?? `<p>${r.text}</p>`}</div></div>`
      : `<div class="standard-markdown">${r.html ?? `<p>${r.text}</p>`}</div>`
    const artifact = r.artifact
      ? `<div class="font-claude-response" id="markdown-artifact"><div class="standard-markdown"><p>${r.artifact}</p></div></div>`
      : ''
    const response = r.streamingOnAncestor
      ? `<div data-is-streaming="${flag}"><div class="font-claude-response">${markdown}</div></div>`
      : `<div class="font-claude-response" data-is-streaming="${flag}">${markdown}</div>`
    inner = `${response}${artifact}
      <div role="group" aria-label="Message actions"><button data-testid="action-bar-copy">Copy</button>
      <button data-testid="action-bar-retry">Retry</button></div>`
  }
  return `<div data-index="${r.index}"${size}><div data-test-render-count="2">${inner}</div></div>`
}

export function claudePage(o: ClaudePageOptions): string {
  const [from, to] = o.mounted ?? [0, o.rows.length - 1]
  const setsize = o.setsize === undefined ? o.rows.length : o.setsize
  const rows = o.rows
    .filter((_, i) => i >= from && i <= to)
    .map((r) => rowHtml(r, setsize))
    .join('\n')
  const scrollerOpen = o.noScroller
    ? '<div class="overflow-y-auto overflow-x-hidden flex-1">'
    : '<div data-autoscroll-container="true" class="overflow-y-auto overflow-x-hidden flex-1">'
  return `
    <nav class="dframe-nav-scroll overflow-y-auto overflow-x-hidden flex-1">
      <a href="/chat/22222222-2222-4222-8222-222222222222">Another chat</a>
    </nav>
    ${scrollerOpen}
      <div class="mx-auto max-w-3xl">${rows}</div>
    </div>
    <fieldset><div data-testid="chat-input" contenteditable="true"></div></fieldset>`
}

/** Sign-in page (synthetic): an e-mail form and no composer. */
export const claudeLoginPage = `
  <main><h1>Welcome back</h1>
  <form><label>Email <input type="email" name="email"></label><button>Continue with email</button></form></main>`
