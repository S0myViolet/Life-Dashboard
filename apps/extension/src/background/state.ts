/**
 * Everything the service worker persists in chrome.storage.local. The worker is
 * stopped after ~30 s idle and its globals are lost, so all state lives here.
 * The local area is restricted to trusted contexts (the worker and the
 * extension's own pages; see ChromeApi.restrictStorage) before a token is ever
 * written, so the content scripts inside chatgpt.com / claude.ai cannot read or
 * rewrite it. The token never leaves the service worker except as a Bearer
 * header to the paired dashboard origin; pages get a view without it.
 */
import type { CaptureProblemState, CaptureProvider, CaptureSelectionItem } from '@personal-home/core'
import type { ActivityEntry } from '../shared/protocol.ts'
import type { UploadItem } from '../shared/queue.ts'
import { emptyRevisitState, type RevisitState } from '../shared/revisit.ts'

export interface Pairing {
  /** Origin the helper calls (the one the owner granted access to). */
  apiOrigin: string
  /** Canonical dashboard origin reported by the server (used to open pages). */
  dashboardOrigin: string
  token: string
  deviceId: string
  deviceName: string
  pairedAt: number
  /** Set when the dashboard stopped accepting the token or this browser's origin. */
  authFailedAt: number | null
  authFailure: 'revoked' | 'origin' | null
}

export interface SelectionCache {
  items: CaptureSelectionItem[]
  /** Last successful sync (null: never). Items are kept when a sync fails. */
  syncedAt: number | null
  error: string | null
}

export interface Settings {
  pausedAll: boolean
  /** Background revisits prototype: off unless the owner opts in. */
  revisitEnabled: boolean
  revisitAcknowledgedAt: number | null
}

export interface ConversationStatus {
  lastCapturedAt: number | null
  lastUploadAt: number | null
  lastResult: string | null
  /** A problem this helper reported; cleared when the conversation is active again, or after a day. */
  problem: {
    state: CaptureProblemState
    at: number
    provider: CaptureProvider
    externalId: string
    url: string
  } | null
}

export const PROBLEM_TTL_MS = 24 * 60 * 60_000

export interface StoredState {
  pairing: Pairing | null
  selection: SelectionCache
  settings: Settings
  queue: UploadItem[]
  /** Keyed by conversation id (from the selection). */
  conversations: Record<string, ConversationStatus>
  revisit: RevisitState
  log: ActivityEntry[]
  lastTickAt: number | null
}

export type StateKey = keyof StoredState

export const STATE_DEFAULTS = (): StoredState => ({
  pairing: null,
  selection: { items: [], syncedAt: null, error: null },
  settings: { pausedAll: false, revisitEnabled: false, revisitAcknowledgedAt: null },
  queue: [],
  conversations: {},
  revisit: emptyRevisitState(),
  log: [],
  lastTickAt: null,
})

export const LOG_LIMIT = 60

export function appendLog(log: ActivityEntry[], entry: ActivityEntry): ActivityEntry[] {
  return [entry, ...log].slice(0, LOG_LIMIT)
}

export const emptyConversationStatus = (): ConversationStatus => ({
  lastCapturedAt: null,
  lastUploadAt: null,
  lastResult: null,
  problem: null,
})
