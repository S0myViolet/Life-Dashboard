/**
 * claude.ai extractor. Selectors come from docs/research/chat-dom.md
 * (open-source exporters, 2026):
 *   - thread scroller: [data-autoscroll-container] (the only element carrying it;
 *     class-based selectors broke with the 2026-09 sidebar redesign);
 *   - rows: [data-index] wrappers, one per message, monotonic. The row index is
 *     the message's position, so an edited message keeps its key
 *     ('d:<index>:<role>:0') and becomes a new version;
 *   - user: [data-testid="user-message"] (attachment-only rows have none and
 *     carry no text, so they are skipped);
 *   - assistant: .font-claude-response (not the #markdown-artifact Deep Research
 *     panel), legacy .font-claude-message; markdown .standard-markdown /
 *     .progressive-markdown (nested while streaming, so only outermost ones);
 *   - streaming: data-is-streaming="true" on the response or an ancestor;
 *   - aria-setsize on rows (when present) is the total row count, so coverage
 *     can tell which rows were never mounted.
 */
import { capturePositionKey, type CaptureRole } from '@personal-home/core'
import {
  cleanTitle,
  emptyExtract,
  hasContentMedia,
  localKeyFor,
  looksLikeChallenge,
  nearBottom,
  nearTop,
  type ExtractedMessage,
  type PageExtract,
} from './extract.ts'
import { outermost, renderedText } from './text.ts'

const SCROLLER = '[data-autoscroll-container]'
const ROW = '[data-index]'
const USER = '[data-testid="user-message"]'
const ASSISTANT = '.font-claude-response:not(#markdown-artifact), .font-claude-message'
const MARKDOWN = '.standard-markdown, .progressive-markdown'
const COMPOSER = '[data-testid="chat-input"]'

function assistantText(el: Element): string {
  const roots = outermost(el, MARKDOWN).filter((r) => !r.closest('#markdown-artifact'))
  if (roots.length === 0) return renderedText(el)
  return roots.map((r) => renderedText(r)).filter((t) => t.length > 0).join('\n\n')
}

function streamingFlag(el: Element, row: Element): boolean {
  const own = el.closest('[data-is-streaming]')
  const marker = own && row.contains(own) ? own : row.querySelector('[data-is-streaming]')
  return marker?.getAttribute('data-is-streaming') === 'true'
}

function setSize(rows: Element[]): number | null {
  for (const row of rows) {
    const holder = row.hasAttribute('aria-setsize') ? row : row.querySelector('[aria-setsize]')
    const n = Number(holder?.getAttribute('aria-setsize'))
    if (Number.isInteger(n) && n > 0) return n
  }
  return null
}

const rowIndex = (row: Element): number | null => {
  const index = Number(row.getAttribute('data-index'))
  return Number.isInteger(index) && index >= 0 && index <= 1e7 ? index : null
}

export function extractClaude(doc: Document): PageExtract {
  const scroller = doc.querySelector(SCROLLER)
  const scope: Element | Document = scroller ?? doc
  const allRows = outermost(scope, ROW)
  const rows = allRows.filter((row) => row.querySelector(`${USER}, ${ASSISTANT}, [data-is-streaming]`) !== null)

  if (rows.length === 0) {
    if (doc.querySelector(`${USER}, ${ASSISTANT}`) !== null) return emptyExtract('structure_changed')
    if (looksLikeChallenge(doc)) return emptyExtract('challenge')
    const path = doc.location?.pathname ?? ''
    const loginForm =
      doc.querySelector('form input[type="email"]') !== null && doc.querySelector(COMPOSER) === null
    if (/^\/(login|logout)(\/|$)/.test(path) || loginForm) return emptyExtract('signed_out')
    return emptyExtract('loading')
  }

  const messages: ExtractedMessage[] = []
  const indexes: number[] = []
  const renderedPositions: string[] = []
  let firstRowHasText = false
  rows.forEach((row, position) => {
    const index = rowIndex(row)
    if (index === null) return
    const user = row.querySelector(USER)
    const assistant = row.querySelector(ASSISTANT)
    const found: { role: CaptureRole; el: Element }[] = []
    if (user) found.push({ role: 'user', el: user })
    if (assistant) found.push({ role: 'assistant', el: assistant })
    let rowHasText = false
    let rowComplete = found.length > 0
    found.forEach(({ role, el }, i) => {
      const text = role === 'assistant' ? assistantText(el) : renderedText(el)
      const key = capturePositionKey(index, role, 0)
      rowHasText ||= text.length > 0
      rowComplete &&= text.length > 0
      messages.push({
        key,
        localKey: localKeyFor(key, role, ''),
        role,
        text,
        orderHint: index + i / 2,
        isStreaming: role === 'assistant' && streamingFlag(el, row),
      })
    })
    indexes.push(index)
    if (rowComplete) renderedPositions.push(String(index))
    if (position === 0) firstRowHasText = rowHasText
  })
  // Rows without a message (attachment-only prompts) hold nothing collectable;
  // once they show their content they count as seen for coverage.
  for (const row of allRows) {
    const index = rowIndex(row)
    if (index === null || rows.includes(row)) continue
    if (renderedText(row).length > 0 || hasContentMedia(row)) renderedPositions.push(String(index))
  }

  if (messages.length === 0) return emptyExtract('structure_changed')

  const minIndex = Math.min(...indexes)
  const maxIndex = Math.max(...indexes)
  const total = setSize(rows)
  const firstMounted =
    firstRowHasText && (minIndex === 0 || (scroller !== null && nearTop(scroller)))
  const lastRow = rows[rows.length - 1]!
  const lastRowHasText = messages.some(
    (m) => m.text.length > 0 && m.key === capturePositionKey(Number(lastRow.getAttribute('data-index')), m.role, 0),
  )
  const lastMounted =
    scroller !== null && nearBottom(scroller) && lastRowHasText && (total === null || maxIndex >= total - 1)
  const streaming = doc.querySelector('[data-is-streaming="true"]') !== null

  // Rows are numbered from 0, so the thread is rows 0..total-1 (aria-setsize),
  // or 0..last while the last row is mounted.
  const allIndexes = allRows.map(rowIndex).filter((i): i is number => i !== null)
  const lastIndex = total !== null ? total - 1 : lastMounted ? Math.max(...allIndexes) : null
  const threadPositions =
    lastIndex !== null && lastIndex < 100_000 ? Array.from({ length: lastIndex + 1 }, (_, i) => String(i)) : null

  const title = cleanTitle(doc.title, 'claude')
  return {
    status: 'ok',
    messages,
    firstMounted,
    lastMounted,
    streaming,
    renderedPositions,
    threadPositions,
    ...(title ? { title } : {}),
  }
}
