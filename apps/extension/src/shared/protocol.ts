/**
 * Messages between the content scripts, the extension pages (popup, options)
 * and the service worker. The service worker validates every message it
 * receives and checks who sent it (see background/senders.ts).
 */
import type {
  CaptureMode,
  CaptureProblemState,
  CaptureProvider,
  CaptureRole,
  CaptureSelectionItem,
  CaptureState,
} from '@personal-home/core'

/** One message as the content script saw it (possibly accumulated over scrolling). */
export interface ObservedMessage {
  /** Provider message/turn id, or the helper's position key for Claude rows. */
  key?: string
  role: CaptureRole
  text: string
  orderHint?: number
  isStreaming: boolean
}

/** The accumulated state of one open conversation page. */
export interface PageObservation {
  url: string
  title?: string
  /** Random id for this page visit; newer observations of a session supersede older ones. */
  sessionId: string
  /** ISO instant of this observation. */
  capturedAt: string
  messages: ObservedMessage[]
  observedFirstMessage: boolean
  observedLastMessage: boolean
  /** Every position of the thread was rendered at some point during this visit (no gaps). */
  contiguous: boolean
  /** Thread positions the page listed but never rendered during this visit (absent: unknown). */
  missingCount?: number
  renderedCount: number
  streamingInProgress: boolean
}

export type ContentRequest =
  | { type: 'ph:hello'; url: string }
  | { type: 'ph:observation'; observation: PageObservation }
  | { type: 'ph:problem'; url: string; state: CaptureProblemState }

export interface HelloResponse {
  collect: boolean
  mode: CaptureMode
  /** Why collection is off (shown nowhere on the page; for debugging in the console). */
  reason?: 'not_conversation' | 'not_paired' | 'not_selected' | 'not_active' | 'paused_all' | 'auth_failed'
}

export interface ObservationResponse {
  accepted: boolean
  queued: number
}

/** Service worker → content script (chrome.tabs.sendMessage). */
export type ContentNotice = { type: 'ph:recheck' }

export interface RevisitCollectorView {
  provider: CaptureProvider
  conversationId: string
  url: string
  openedAt: number
}

export interface ActivityEntry {
  at: number
  kind: 'info' | 'warning' | 'problem'
  text: string
}

export interface ConversationView {
  id: string
  provider: CaptureProvider
  externalId: string
  url: string
  captureState: CaptureState
  lastUploadAt: number | null
  lastResult: string | null
}

/** What the popup and options page render. Never contains the device token. */
export interface HelperStateView {
  paired: boolean
  apiOrigin: string | null
  dashboardOrigin: string | null
  deviceName: string | null
  pairedAt: number | null
  authFailed: boolean
  pausedAll: boolean
  selectionSyncedAt: number | null
  selectionError: string | null
  conversations: ConversationView[]
  queued: number
  nextRetryAt: number | null
  revisit: {
    enabled: boolean
    acknowledgedAt: number | null
    blocked: Partial<Record<CaptureProvider, { reason: string; at: number }>>
    collectors: RevisitCollectorView[]
    queued: number
  }
  log: ActivityEntry[]
  extensionVersion: string
}

export type PageRequest =
  | { type: 'ph:get-state' }
  | { type: 'ph:pair'; apiOrigin: string; code: string; deviceName: string }
  | { type: 'ph:unpair' }
  | { type: 'ph:set-paused-all'; paused: boolean }
  | { type: 'ph:set-revisit'; enabled: boolean; acknowledged: boolean }
  | { type: 'ph:resume-revisits'; provider: CaptureProvider }
  | { type: 'ph:sync-now' }
  | { type: 'ph:track'; url: string }

export type PairResult =
  | { ok: true; state: HelperStateView }
  | { ok: false; error: string; message: string }

export type { CaptureSelectionItem }
