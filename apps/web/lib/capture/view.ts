/**
 * Plain-language copy for capture states and coverage. Pure, so it is unit tested
 * and shared by the Chrome helper settings page and the Projects page.
 */
import type { CaptureCoverage, CaptureState, ConnectionStatus } from '@personal-home/core'

export type CaptureTone = 'neutral' | 'positive' | 'caution' | 'danger' | 'accent'

export const CAPTURE_STATE_COPY: Record<
  CaptureState,
  { label: string; tone: CaptureTone; help: string; connection: ConnectionStatus }
> = {
  active: {
    label: 'Collecting',
    tone: 'positive',
    help: 'Captured whenever you have it open in Chrome with the helper installed.',
    connection: 'connected',
  },
  paused: {
    label: 'Paused',
    tone: 'caution',
    help: 'You paused it. Saved messages are kept; nothing new is collected.',
    connection: 'paused',
  },
  needs_attention: {
    label: 'Capture needs attention',
    tone: 'danger',
    help: 'The page showed a verification challenge, so the helper stopped. Open the conversation, complete the check yourself, then choose Reconnect.',
    connection: 'needs_reconnect',
  },
  signed_out: {
    label: 'Reconnect',
    tone: 'danger',
    help: 'The page was signed out, so the helper stopped. Sign in to the service in Chrome, then choose Reconnect.',
    connection: 'needs_reconnect',
  },
  structure_changed: {
    label: 'Capture needs attention',
    tone: 'danger',
    help: 'The page no longer looked the way the helper expects (the service may have changed its layout). Saved messages are kept. The helper may need an update before Reconnect works.',
    connection: 'error',
  },
}

export function captureResumeLabel(state: CaptureState): string {
  return state === 'paused' ? 'Resume' : 'Reconnect'
}

interface CoverageInput {
  messageCount: number
  lastCapturedAt: Date | null
  lastSeenCompleteAt: Date | null
  lastSnapshot: {
    outcome: string
    reason: string | null
    mode: string
    coverage: Partial<CaptureCoverage>
  } | null
}

/**
 * One honest sentence about how much of the conversation has actually been
 * collected. "Every message" is claimed only when the latest capture was
 * complete: first and last message seen, and every message between them seen
 * during the same page visit (no gaps; see core captureCoverageIsComplete).
 */
export function captureCoverageSummary(c: CoverageInput): string {
  if (!c.lastCapturedAt || c.messageCount === 0) {
    return 'Nothing collected yet. Open the conversation in Chrome with the helper paired.'
  }
  const stored = `${c.messageCount} message${c.messageCount === 1 ? '' : 's'} saved`
  if (c.lastSeenCompleteAt && c.lastSeenCompleteAt.getTime() >= c.lastCapturedAt.getTime()) {
    return `${stored}. The latest capture saw every message from the first to the last.`
  }
  const cov = c.lastSnapshot?.coverage ?? {}
  const parts: string[] = []
  if (cov.observedFirstMessage === false) parts.push('the start was not in view (scroll to the top once to collect older messages)')
  if (cov.observedLastMessage === false) parts.push('the end was not in view')
  const missing = cov.missingCount ?? 0
  if (missing > 0 || (cov.contiguous !== true && cov.observedFirstMessage && cov.observedLastMessage)) {
    const count = missing > 0 ? ` (${missing} turn${missing === 1 ? '' : 's'} not seen)` : ''
    parts.push(
      `some messages between the first and the last were never in view${count}; scroll through the whole conversation once, without jumping to the top or bottom`,
    )
  }
  if (cov.streamingInProgress) parts.push('a reply was still being written')
  if ((cov.omittedCount ?? 0) > 0) parts.push(`${cov.omittedCount} message(s) were too large to send`)
  const detail = parts.length > 0 ? ` In the latest capture ${parts.join('; ')}.` : ''
  const complete = c.lastSeenCompleteAt ? '' : ' No capture has seen every message from the first to the last yet.'
  return `${stored}.${detail}${complete}`
}

const RTF = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' })

/** '3 minutes ago', 'yesterday', or a date for anything older than a week. */
export function captureRelativeTime(when: Date, now: Date, timeZone: string): string {
  const seconds = Math.round((when.getTime() - now.getTime()) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 60) return 'just now'
  if (abs < 3600) return RTF.format(Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return RTF.format(Math.round(seconds / 3600), 'hour')
  if (abs < 7 * 86_400) return RTF.format(Math.round(seconds / 86_400), 'day')
  return captureFormatDateTime(when, timeZone)
}

export function captureFormatDateTime(when: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(when)
}

/** Short conversation label: the captured title, or the provider and a short id. */
export function captureConversationLabel(c: { title: string | null; provider: string; externalId: string }): string {
  const title = c.title?.trim()
  if (title) return title
  return `${c.provider === 'chatgpt' ? 'ChatGPT' : 'Claude'} conversation ${c.externalId.slice(0, 8)}`
}
