/**
 * Claude extractor against SYNTHETIC DOM fixtures (test/fixtures/claude.ts),
 * shaped from docs/research/chat-dom.md. Not captured from the live service.
 */
import { describe, expect, it } from 'vitest'
import { extractClaude } from '../src/content/extract-claude.ts'
import { challengePage, setScroll } from './fixtures/chatgpt.ts'
import { claudeLoginPage, claudePage, claudeThread, type ClaudeRow } from './fixtures/claude.ts'
import { CLAUDE_URL, pageDocument } from './helpers.ts'

const doc = (html: string, url = CLAUDE_URL, title = 'Garden design - Claude') => pageDocument(html, url, title)

describe('extractClaude', () => {
  it('reads rows by data-index with position keys, roles and text', () => {
    const d = doc(claudePage({ rows: claudeThread(4) }))
    const x = extractClaude(d)
    expect(x.status).toBe('ok')
    expect(x.messages.map((m) => [m.key, m.role, m.text, m.orderHint])).toEqual([
      ['d:0:user:0', 'user', 'Synthetic Claude message 0', 0],
      ['d:1:assistant:0', 'assistant', 'Synthetic Claude message 1', 1],
      ['d:2:user:0', 'user', 'Synthetic Claude message 2', 2],
      ['d:3:assistant:0', 'assistant', 'Synthetic Claude message 3', 3],
    ])
    expect(x.messages.every((m) => !/Copy|Retry|Edit|1 \/ 2/.test(m.text))).toBe(true)
    expect(x.title).toBe('Garden design')
  })

  it('an edited message keeps its row position and therefore its key', () => {
    const rows = claudeThread(2)
    const before = extractClaude(doc(claudePage({ rows })))
    rows[0]!.text = 'Edited question'
    const after = extractClaude(doc(claudePage({ rows })))
    expect(after.messages[0]!.key).toBe(before.messages[0]!.key)
    expect(after.messages[0]!.text).toBe('Edited question')
  })

  it('flags streaming replies whether the attribute is on the response or an ancestor, without duplicating nested markdown', () => {
    for (const streamingOnAncestor of [false, true]) {
      const rows: ClaudeRow[] = [
        { index: 0, role: 'user', text: 'Question' },
        { index: 1, role: 'assistant', text: 'Partial answer', streaming: true, streamingOnAncestor },
      ]
      const x = extractClaude(doc(claudePage({ rows })))
      expect(x.streaming).toBe(true)
      expect(x.messages[1]).toMatchObject({ isStreaming: true, text: 'Partial answer' })
    }
    const done = extractClaude(doc(claudePage({ rows: claudeThread(2) })))
    expect(done.streaming).toBe(false)
    expect(done.messages[1]!.isStreaming).toBe(false)
  })

  it('skips attachment-only rows and Deep Research artifacts', () => {
    const rows: ClaudeRow[] = [
      { index: 0, role: 'attachment', text: '' },
      { index: 1, role: 'user', text: 'Summarise the attached report' },
      { index: 2, role: 'assistant', text: 'Here is the summary', artifact: 'ARTIFACT BODY' },
    ]
    const x = extractClaude(doc(claudePage({ rows })))
    expect(x.messages.map((m) => m.key)).toEqual(['d:1:user:0', 'd:2:assistant:0'])
    expect(x.messages[1]!.text).toBe('Here is the summary')
  })

  it('ignores the redesigned sidebar that shares the scroller classes', () => {
    const x = extractClaude(doc(claudePage({ rows: claudeThread(2) })))
    expect(x.messages).toHaveLength(2)
  })

  it('uses the first row index and aria-setsize for honest coverage', () => {
    const rows = claudeThread(56)
    const cold = doc(claudePage({ rows, mounted: [50, 55] }))
    setScroll(cold, '[data-autoscroll-container]', 'bottom')
    expect(extractClaude(cold)).toMatchObject({ firstMounted: false, lastMounted: true })

    const top = doc(claudePage({ rows, mounted: [0, 5] }))
    setScroll(top, '[data-autoscroll-container]', 'top')
    expect(extractClaude(top)).toMatchObject({ firstMounted: true, lastMounted: false })

    // Scrolled to the bottom but the declared total is larger than what is mounted.
    const short = doc(claudePage({ rows, mounted: [40, 45] }))
    setScroll(short, '[data-autoscroll-container]', 'bottom')
    expect(extractClaude(short).lastMounted).toBe(false)
  })

  it('reports structure_changed when messages render outside [data-index] rows', () => {
    const html = claudePage({ rows: claudeThread(2) }).replace(/data-index="\d+"/g, 'data-row="x"')
    expect(extractClaude(doc(html)).status).toBe('structure_changed')
  })

  it('reports loading while nothing is rendered, and signed_out / challenge pages', () => {
    expect(extractClaude(doc('<div data-autoscroll-container></div><div data-testid="chat-input"></div>')).status).toBe(
      'loading',
    )
    expect(extractClaude(doc(claudeLoginPage, 'https://claude.ai/login?returnTo=%2Fchat')).status).toBe('signed_out')
    expect(extractClaude(doc(claudeLoginPage)).status).toBe('signed_out')
    expect(extractClaude(doc(challengePage, CLAUDE_URL, 'Just a moment...')).status).toBe('challenge')
  })
})
