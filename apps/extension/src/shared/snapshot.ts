/**
 * Turns a page observation into one or more v1 snapshot payloads that respect
 * the capture endpoint's hard limits (core CAPTURE_LIMITS):
 *   - a message longer than 200,000 characters is left out (counted in
 *     coverage.omittedCount) rather than truncated: a truncated text would be
 *     stored as a false edit;
 *   - more than 2,000 messages, or a body over ~2 MB, is split into several
 *     snapshots of consecutive messages. The server never deletes messages that
 *     are missing from a snapshot, so chunks are safe, and every chunk reports
 *     honestly that it does not cover the whole page (omittedCount > 0).
 */
import {
  CAPTURE_LIMITS,
  CAPTURE_MESSAGE_KEY_RE,
  type CaptureCoverage,
  type CaptureMessage,
  type CaptureMode,
  type CaptureProvider,
  type CaptureSnapshot,
} from '@personal-home/core'
import type { PageObservation } from './protocol.ts'

/** Leave room for the envelope and JSON escaping differences. */
const BODY_BUDGET = CAPTURE_LIMITS.maxPayloadBytes - 64 * 1024

const encoder = new TextEncoder()
const byteLength = (value: unknown) => encoder.encode(JSON.stringify(value)).length

export interface BuildSnapshotsInput {
  provider: CaptureProvider
  externalId: string
  canonicalUrl: string
  observation: PageObservation
  mode: CaptureMode
  extensionVersion: string
  newId: () => string
  /** For tests; defaults to the endpoint's budget. */
  maxBodyBytes?: number
  maxMessages?: number
}

export interface BuiltSnapshots {
  snapshots: CaptureSnapshot[]
  /** Messages left out entirely because a single one exceeded the text limit. */
  oversized: number
}

function cleanTitle(title: string | undefined): string | undefined {
  if (!title) return undefined
  const t = title.replace(/\s+/g, ' ').trim().slice(0, CAPTURE_LIMITS.maxTitleChars)
  return t.length > 0 ? t : undefined
}

function toWireMessage(m: PageObservation['messages'][number]): CaptureMessage {
  const out: CaptureMessage = { role: m.role, text: m.text }
  if (m.key !== undefined && CAPTURE_MESSAGE_KEY_RE.test(m.key)) out.key = m.key
  if (m.orderHint !== undefined && Number.isFinite(m.orderHint) && Math.abs(m.orderHint) <= 1e9) {
    out.orderHint = m.orderHint
  }
  if (m.isStreaming) out.isStreaming = true
  return out
}

export function buildSnapshots(input: BuildSnapshotsInput): BuiltSnapshots {
  const { observation: obs } = input
  const maxBody = input.maxBodyBytes ?? BODY_BUDGET
  const maxMessages = Math.min(input.maxMessages ?? CAPTURE_LIMITS.maxMessages, CAPTURE_LIMITS.maxMessages)

  const eligible: CaptureMessage[] = []
  let oversized = 0
  for (const m of obs.messages) {
    if (m.text.length > CAPTURE_LIMITS.maxMessageChars) {
      oversized++
      continue
    }
    eligible.push(toWireMessage(m))
  }

  const total = obs.messages.length
  const title = cleanTitle(obs.title)
  const envelope = (messages: CaptureMessage[], coverage: CaptureCoverage): CaptureSnapshot => ({
    schemaVersion: 1,
    snapshotId: input.newId(),
    provider: input.provider,
    conversation: {
      externalId: input.externalId,
      url: input.canonicalUrl,
      ...(title ? { title } : {}),
    },
    messages,
    capturedAt: obs.capturedAt,
    coverage,
    extensionVersion: input.extensionVersion,
  })
  const coverageFor = (count: number, first: boolean, last: boolean): CaptureCoverage => ({
    mode: input.mode,
    observedFirstMessage: obs.observedFirstMessage && first,
    observedLastMessage: obs.observedLastMessage && last,
    contiguous: obs.contiguous === true,
    ...(obs.missingCount !== undefined ? { missingCount: Math.min(Math.max(0, obs.missingCount), 1_000_000) } : {}),
    renderedCount: Math.min(obs.renderedCount, 1_000_000),
    accumulatedCount: Math.min(total, 1_000_000),
    streamingInProgress: obs.streamingInProgress,
    pageState: 'ok',
    ...(total - count > 0 ? { omittedCount: total - count } : {}),
  })

  // Greedy chunking of consecutive messages by count and serialized size.
  const overhead = byteLength(envelope([], coverageFor(0, true, true))) + 64
  const chunks: CaptureMessage[][] = []
  let current: CaptureMessage[] = []
  let currentBytes = overhead
  for (const m of eligible) {
    const size = byteLength(m) + 1
    if (current.length > 0 && (current.length >= maxMessages || currentBytes + size > maxBody)) {
      chunks.push(current)
      current = []
      currentBytes = overhead
    }
    current.push(m)
    currentBytes += size
  }
  if (current.length > 0) chunks.push(current)

  const snapshots = chunks.map((messages, i) =>
    envelope(
      messages,
      coverageFor(messages.length, i === 0 && oversized === 0, i === chunks.length - 1 && oversized === 0),
    ),
  )
  return { snapshots, oversized }
}

/** Serialized size of a request body, as the endpoint measures it. */
export function snapshotBodyBytes(snapshot: CaptureSnapshot): number {
  return byteLength(snapshot)
}
