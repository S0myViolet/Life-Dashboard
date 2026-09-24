/**
 * Accumulates what a virtualised thread shows while the owner scrolls.
 *
 * Both apps mount only a window of turns and unmount the rest, so one DOM read
 * loses messages. Each observation is merged by message key: new messages are
 * added next to their neighbours, known ones get their latest settled text,
 * and messages that unmount are kept. Coverage is honest: the first message
 * counts as observed only if it was actually mounted and rendered at some
 * point; the last message only if the latest observation showed it; and the
 * thread counts as gap-free (`contiguous`) only if every position the page
 * lists (ChatGPT turn wrappers, Claude rows) was rendered at some point during
 * this visit. Seeing the top and then the bottom is not enough: jumping between
 * them never mounts the middle of a virtualised thread.
 */
import type { ObservedMessage, PageObservation } from '../shared/protocol.ts'
import type { ExtractedMessage, PageExtract } from './extract.ts'

interface Entry {
  message: ExtractedMessage
}

export class CaptureAccumulator {
  private readonly order: string[] = []
  private readonly entries = new Map<string, Entry>()
  private sawFirst = false
  private lastMounted = false
  /** Thread positions rendered at some point during this visit. */
  private seen = new Set<string>()
  /** The whole thread's positions, from the latest read that could tell. */
  private outline: string[] | null = null
  private streaming = false
  private rendered = 0
  private title: string | undefined
  private version = 0
  private sentVersion = 0

  constructor(
    readonly url: string,
    readonly sessionId: string,
  ) {}

  get size(): number {
    return this.entries.size
  }

  /** Merge one extract. Returns true when anything that would be uploaded changed. */
  observe(extract: PageExtract): boolean {
    if (extract.status !== 'ok') return false
    let changed = false
    let edited = false
    const window = extract.messages.filter((m) => m.text.length > 0)

    window.forEach((m, i) => {
      const existing = this.entries.get(m.localKey)
      if (!existing) {
        this.insert(m.localKey, window, i)
        this.entries.set(m.localKey, { message: { ...m } })
        changed = true
        return
      }
      const prev = existing.message
      if (
        prev.text !== m.text ||
        prev.isStreaming !== m.isStreaming ||
        prev.role !== m.role ||
        (m.orderHint !== undefined && prev.orderHint !== m.orderHint)
      ) {
        edited ||= prev.text !== m.text && !prev.isStreaming && !m.isStreaming
        existing.message = { ...m, orderHint: m.orderHint ?? prev.orderHint }
        changed = true
      }
    })

    // A settled message changed (an edit, or a branch switch that swaps what
    // Claude shows at the same row positions): rows that are not mounted now
    // may have changed too, so they must be seen again before coverage is whole.
    if (edited) {
      this.seen = new Set(extract.renderedPositions)
      changed = true
    }
    for (const p of extract.renderedPositions) {
      if (!this.seen.has(p)) {
        this.seen.add(p)
        changed = true
      }
    }
    const outline = extract.threadPositions
    if (outline && (!this.outline || outline.length !== this.outline.length || outline.some((p, i) => p !== this.outline![i]))) {
      this.outline = [...outline]
      changed = true
    }

    if (extract.firstMounted && !this.sawFirst) {
      this.sawFirst = true
      changed = true
    }
    if (extract.lastMounted !== this.lastMounted) {
      this.lastMounted = extract.lastMounted
      changed = true
    }
    if (extract.streaming !== this.streaming) {
      this.streaming = extract.streaming
      changed = true
    }
    // The end of the thread is in view and nothing is streaming: a message still
    // flagged from an earlier read but no longer mounted is not being written
    // (the stream ended while the owner looked elsewhere, or it was flagged
    // wrongly). Without this, one stale flag would hold every upload of the
    // visit for the streaming wait and keep its coverage incomplete.
    if (extract.lastMounted && !extract.streaming) {
      const mounted = new Set(window.map((m) => m.localKey))
      for (const [key, entry] of this.entries) {
        if (entry.message.isStreaming && !mounted.has(key)) {
          entry.message = { ...entry.message, isStreaming: false }
          changed = true
        }
      }
    }
    this.rendered = window.length
    if (extract.title && extract.title !== this.title) {
      this.title = extract.title
      changed = true
    }
    if (changed) this.version++
    return changed
  }

  /** Place a new key after its nearest known predecessor in the window (else before its successor). */
  private insert(key: string, window: ExtractedMessage[], i: number) {
    for (let p = i - 1; p >= 0; p--) {
      const at = this.order.indexOf(window[p]!.localKey)
      if (at >= 0) {
        this.order.splice(at + 1, 0, key)
        return
      }
    }
    for (let n = i + 1; n < window.length; n++) {
      const at = this.order.indexOf(window[n]!.localKey)
      if (at >= 0) {
        this.order.splice(at, 0, key)
        return
      }
    }
    this.order.push(key)
  }

  /** Messages in thread order: by position hint when every message has one, else merge order. */
  messages(): ObservedMessage[] {
    const list = this.order.map((k) => this.entries.get(k)!.message)
    if (list.every((m) => m.orderHint !== undefined)) {
      list.sort((a, b) => a.orderHint! - b.orderHint!)
    }
    return list.map((m) => ({
      ...(m.key !== undefined ? { key: m.key } : {}),
      role: m.role,
      text: m.text,
      ...(m.orderHint !== undefined ? { orderHint: m.orderHint } : {}),
      isStreaming: m.isStreaming,
    }))
  }

  get hasUnsent(): boolean {
    return this.version !== this.sentVersion
  }

  /** Counter of changes so far; pass it to markSent for the observation it produced. */
  get changes(): number {
    return this.version
  }

  get isStreaming(): boolean {
    return this.streaming || [...this.entries.values()].some((e) => e.message.isStreaming)
  }

  /** The observation built at `version` was accepted; later changes stay unsent. */
  markSent(version = this.version): void {
    this.sentVersion = Math.max(this.sentVersion, version)
  }

  /** Positions the page lists that were never rendered during this visit (null: the page does not say). */
  get missingCount(): number | null {
    return this.outline ? this.outline.filter((p) => !this.seen.has(p)).length : null
  }

  toObservation(now: Date): PageObservation | null {
    if (this.entries.size === 0) return null
    const missing = this.missingCount
    return {
      url: this.url,
      ...(this.title ? { title: this.title } : {}),
      sessionId: this.sessionId,
      capturedAt: now.toISOString(),
      messages: this.messages(),
      observedFirstMessage: this.sawFirst,
      observedLastMessage: this.lastMounted,
      contiguous: missing === 0 && this.outline !== null && this.outline.length > 0,
      ...(missing !== null ? { missingCount: missing } : {}),
      renderedCount: this.rendered,
      streamingInProgress: this.isStreaming,
    }
  }
}
