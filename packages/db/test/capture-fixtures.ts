/**
 * SYNTHETIC FIXTURE (not captured from the live service): snapshot builders for
 * capture tests, shaped like the Chrome helper's v1 payload.
 */
import { randomUUID } from 'node:crypto'
import type { CaptureCoverage, CaptureSnapshot } from '@personal-home/core'

export const CHAT_ID = '0b6a1f5e-9a3c-4c1e-8f2d-3a4b5c6d7e8f'
export const CHAT_URL = `https://chatgpt.com/c/${CHAT_ID}`
export const CLAUDE_ID = '5d1c0e2f-7b8a-4c3d-9e0f-1a2b3c4d5e6f'
export const CLAUDE_URL = `https://claude.ai/chat/${CLAUDE_ID}`

export const T0 = Date.parse('2026-09-24T09:00:00.000Z')
export const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()

export interface FixtureMessage {
  key?: string
  role: 'user' | 'assistant'
  text: string
  orderHint?: number
  isStreaming?: boolean
}

export function makeSnapshot(
  capturedAt: string,
  messages: FixtureMessage[],
  options: {
    coverage?: Partial<CaptureCoverage>
    provider?: 'chatgpt' | 'claude'
    snapshotId?: string
    title?: string
  } = {},
): CaptureSnapshot {
  const provider = options.provider ?? 'chatgpt'
  return {
    schemaVersion: 1,
    snapshotId: options.snapshotId ?? randomUUID(),
    provider,
    conversation: {
      externalId: provider === 'chatgpt' ? CHAT_ID : CLAUDE_ID,
      url: provider === 'chatgpt' ? CHAT_URL : CLAUDE_URL,
      ...(options.title ? { title: options.title } : {}),
    },
    messages,
    capturedAt,
    coverage: {
      mode: 'passive',
      observedFirstMessage: true,
      observedLastMessage: true,
      contiguous: true,
      renderedCount: messages.length,
      accumulatedCount: messages.length,
      streamingInProgress: messages.some((m) => m.isStreaming),
      pageState: 'ok',
      ...options.coverage,
    },
    extensionVersion: '0.1.0',
  }
}

/** A linear thread of n alternating messages with provider-style ids and position hints. */
export function thread(n: number, prefix = 'msg'): FixtureMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `${prefix}-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `${i % 2 === 0 ? 'Question' : 'Answer'} number ${i}`,
    orderHint: i,
  }))
}
