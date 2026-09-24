/**
 * Accumulates what a virtualised thread shows while the owner scrolls.
 *
 * Both apps mount only a window of turns and unmount the rest, so one DOM read
 * loses messages. Each observation is merged by message key: new messages are
 * added next to their neighbours, known ones get their latest settled text,
 * and messages that unmount are kept. Coverage is honest: the first message
 * counts as observed only if it was actually mounted and rendered at some
 * point; the last message only if the latest observation showed it.
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
        existing.message = { ...m, orderHint: m.orderHint ?? prev.orderHint }
        changed = true
      }
    })

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

  get isStreaming(): boolean {
    return this.streaming || [...this.entries.values()].some((e) => e.message.isStreaming)
  }

  markSent(): void {
    this.sentVersion = this.version
  }

  toObservation(now: Date): PageObservation | null {
    if (this.entries.size === 0) return null
    return {
      url: this.url,
      ...(this.title ? { title: this.title } : {}),
      sessionId: this.sessionId,
      capturedAt: now.toISOString(),
      messages: this.messages(),
      observedFirstMessage: this.sawFirst,
      observedLastMessage: this.lastMounted,
      renderedCount: this.rendered,
      streamingInProgress: this.isStreaming,
    }
  }
}
