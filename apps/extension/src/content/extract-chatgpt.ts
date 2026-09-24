/**
 * chatgpt.com extractor. Selectors come from docs/research/chat-dom.md
 * (open-source exporters, 2026) and prefer data attributes over classes/text:
 *   - turns: [data-testid^="conversation-turn-"] (a <section> since 2026-03, so
 *     the tag is ignored), fallback [data-turn]; data-turn="user|assistant",
 *     data-turn-id=<uuid>. The N in conversation-turn-N is used for ordering only.
 *   - messages: [data-message-author-role][data-message-id]; one assistant turn
 *     can hold several; image-generation turns have no message id (key on
 *     data-turn-id instead) and no text (nothing is stored for them).
 *   - content: assistant .markdown (.prose), user .whitespace-pre-wrap.
 *   - streaming: a visible stop button, or .result-streaming/.streaming-animation.
 *   - virtualisation: persistent [data-turn-id-container] wrappers stay in the
 *     DOM with their content unmounted, so an empty wrapper is not an empty turn.
 *   - scroller: [data-scroll-root].
 */
import type { CaptureRole } from '@personal-home/core'
import {
  cleanTitle,
  emptyExtract,
  localKeyFor,
  looksLikeChallenge,
  nearBottom,
  nearTop,
  safeKey,
  type ExtractedMessage,
  type PageExtract,
} from './extract.ts'
import { outermost, renderedText } from './text.ts'

const TURN = '[data-testid^="conversation-turn-"]'
const TURN_FALLBACK = '[data-turn]'
const MESSAGE = '[data-message-author-role]'
const WRAPPER = '[data-turn-id-container]'
const SCROLL_ROOT = '[data-scroll-root]'
const STOP = [
  '[data-testid="stop-button"]',
  '[data-testid="composer-stop-button"]',
  'button[data-testid="stop-streaming"]',
  'form button[aria-label*="stop" i]:not([aria-label*="dictat" i]):not([aria-label*="voice" i]):not([aria-label*="read" i])',
].join(', ')
const STREAMING_MARK = '.result-streaming, .streaming-animation'
const LOGIN = '[data-testid="login-button"], [data-testid="signup-button"], a[href^="/auth/login"]'

const isRole = (v: string | null): v is CaptureRole => v === 'user' || v === 'assistant'

function turnOrdinal(turn: Element): number | undefined {
  const own = turn.getAttribute('data-testid')
  const testid = own?.startsWith('conversation-turn-')
    ? own
    : (turn.closest(TURN) ?? turn.querySelector(TURN))?.getAttribute('data-testid')
  const m = testid ? /^conversation-turn-(\d{1,7})$/.exec(testid) : null
  return m ? Number(m[1]) : undefined
}

function turnId(turn: Element): string | undefined {
  return safeKey(
    turn.getAttribute('data-turn-id') ??
      turn.closest('[data-turn-id]')?.getAttribute('data-turn-id') ??
      turn.closest(WRAPPER)?.getAttribute('data-turn-id-container'),
  )
}

function contentText(el: Element, role: CaptureRole): string {
  const roots = outermost(el, role === 'assistant' ? '.markdown' : '.whitespace-pre-wrap')
  if (roots.length === 0) return renderedText(el)
  return roots.map((r) => renderedText(r)).filter((t) => t.length > 0).join('\n\n')
}

function hasText(el: Element | undefined, messages: Map<Element, ExtractedMessage[]>): boolean {
  if (!el) return false
  for (const [turn, list] of messages) {
    if ((turn === el || el.contains(turn)) && list.some((m) => m.text.length > 0)) return true
  }
  return false
}

export function extractChatGPT(doc: Document): PageExtract {
  const thread = doc.querySelector('main') ?? doc.body
  if (!thread) return emptyExtract('loading')
  let turns = outermost(thread, TURN)
  if (turns.length === 0) turns = outermost(thread, TURN_FALLBACK)
  // Last resort (turn containers renamed): each message element is its own turn.
  if (turns.length === 0) turns = outermost(thread, MESSAGE)

  const perTurn = new Map<Element, ExtractedMessage[]>()
  const messages: ExtractedMessage[] = []
  let recognised = 0

  for (const turn of turns) {
    const ordinal = turnOrdinal(turn)
    const tid = turnId(turn)
    const turnRole = turn.getAttribute('data-turn')
    const list: ExtractedMessage[] = []
    const elements = (turn.matches(MESSAGE) ? [turn] : outermost(turn, MESSAGE)).filter((el) =>
      isRole(el.getAttribute('data-message-author-role')),
    )
    if (elements.length === 0 && isRole(turnRole)) {
      recognised++
      const text = contentText(turn, turnRole)
      list.push({
        key: tid,
        localKey: localKeyFor(tid, turnRole, `${ordinal ?? ''}:${text}`),
        role: turnRole,
        text,
        ...(ordinal !== undefined ? { orderHint: ordinal } : {}),
        isStreaming: false,
      })
    }
    elements.forEach((el, j) => {
      recognised++
      const role = el.getAttribute('data-message-author-role') as CaptureRole
      const key = safeKey(el.getAttribute('data-message-id')) ?? (elements.length === 1 ? tid : undefined)
      const text = contentText(el, role)
      list.push({
        key,
        localKey: localKeyFor(key, role, `${ordinal ?? ''}:${j}:${text}`),
        role,
        text,
        ...(ordinal !== undefined ? { orderHint: ordinal + j / 100 } : {}),
        isStreaming: el.querySelector(STREAMING_MARK) !== null || el.matches(STREAMING_MARK),
      })
    })
    perTurn.set(turn, list)
    messages.push(...list)
  }

  const stopVisible = doc.querySelector(STOP) !== null
  const markVisible = doc.querySelector(STREAMING_MARK) !== null
  if (stopVisible && !messages.some((m) => m.isStreaming)) {
    // The reply being written is the last assistant message on the page.
    const last = [...messages].reverse().find((m) => m.role === 'assistant')
    if (last) last.isStreaming = true
  }
  const streaming = stopVisible || markVisible

  if (recognised === 0) {
    // Turn containers without any recognisable message: the layout changed.
    if (turns.length > 0) return emptyExtract('structure_changed')
    if (looksLikeChallenge(doc)) return emptyExtract('challenge')
    if (/^\/auth\//.test(doc.location?.pathname ?? '') || doc.querySelector(LOGIN) !== null) {
      return emptyExtract('signed_out')
    }
    return emptyExtract('loading')
  }

  // Coverage: the thread's first/last turn must be mounted with text, and the
  // scroller must be at that end. Persistent empty wrappers mark unmounted turns.
  const scroller = doc.querySelector(SCROLL_ROOT)
  const wrappers = outermost(thread, WRAPPER).filter(
    (w) => w.getAttribute('data-turn-id-container') !== 'client-created-root',
  )
  const firstEl = wrappers.length > 0 ? wrappers[0] : turns[0]
  const lastEl = wrappers.length > 0 ? wrappers[wrappers.length - 1] : turns[turns.length - 1]
  const firstMounted = scroller !== null && nearTop(scroller) && hasText(firstEl, perTurn)
  const lastMounted = scroller !== null && nearBottom(scroller) && hasText(lastEl, perTurn)

  const title = cleanTitle(doc.title, 'chatgpt')
  return { status: 'ok', messages, firstMounted, lastMounted, streaming, ...(title ? { title } : {}) }
}
