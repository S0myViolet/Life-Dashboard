/**
 * Vocabulary and hard limits for ChatGPT/Claude conversation capture.
 * Shared by the database layer, the capture endpoint and the Chrome helper.
 */
import { z } from 'zod'

export const CAPTURE_PROVIDERS = ['chatgpt', 'claude'] as const
export const CaptureProviderSchema = z.enum(CAPTURE_PROVIDERS)
export type CaptureProvider = z.infer<typeof CaptureProviderSchema>

export const CAPTURE_PROVIDER_LABELS: Record<CaptureProvider, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
}

/**
 * Per-conversation capture state.
 *  - active: selected and collected when the page is observed.
 *  - paused: the owner paused it (never changed by the helper).
 *  - needs_attention: a login/bot challenge was shown; the helper stopped.
 *  - signed_out: the provider page was signed out.
 *  - structure_changed: the page no longer matched the expected structure.
 * Every non-active state keeps the last good data and needs the owner to resume.
 */
export const CAPTURE_STATES = [
  'active',
  'paused',
  'needs_attention',
  'signed_out',
  'structure_changed',
] as const
export const CaptureStateSchema = z.enum(CAPTURE_STATES)
export type CaptureState = z.infer<typeof CaptureStateSchema>

/** What the content script saw on the page. Only `ok` snapshots can change stored messages. */
export const CAPTURE_PAGE_STATES = [
  'ok',
  'signed_out',
  'challenge',
  'structure_changed',
  'empty',
] as const
export const CapturePageStateSchema = z.enum(CAPTURE_PAGE_STATES)
export type CapturePageState = z.infer<typeof CapturePageStateSchema>

/** Page states the helper reports through the status endpoint (they pause the conversation). */
export const CAPTURE_PROBLEM_STATES = ['signed_out', 'challenge', 'structure_changed'] as const
export const CaptureProblemStateSchema = z.enum(CAPTURE_PROBLEM_STATES)
export type CaptureProblemState = z.infer<typeof CaptureProblemStateSchema>

export const CAPTURE_ROLES = ['user', 'assistant'] as const
export const CaptureRoleSchema = z.enum(CAPTURE_ROLES)
export type CaptureRole = z.infer<typeof CaptureRoleSchema>

export const CAPTURE_MODES = ['passive', 'revisit'] as const
export const CaptureModeSchema = z.enum(CAPTURE_MODES)
export type CaptureMode = z.infer<typeof CaptureModeSchema>

export const CAPTURE_SNAPSHOT_OUTCOMES = ['applied', 'ignored_partial', 'rejected'] as const
export type CaptureSnapshotOutcome = (typeof CAPTURE_SNAPSHOT_OUTCOMES)[number]

export const CAPTURE_LIMITS = {
  /** Serialized snapshot request body. */
  maxPayloadBytes: 2 * 1024 * 1024,
  maxMessages: 2000,
  maxMessageChars: 200_000,
  maxTitleChars: 500,
  maxKeyChars: 200,
  maxUrlChars: 2048,
  maxDeviceNameChars: 60,
  /** Status reports and pairing requests are tiny. */
  maxSmallBodyBytes: 8 * 1024,
  pairingCodeTtlMinutes: 10,
  /** Failed redemptions that name a code (its first four characters) before it is dead. */
  pairingMaxFailedAttempts: 5,
  /** Failed redemptions one source (client address) may make per window before it must wait. */
  pairingSourceMaxFailures: 10,
  pairingSourceWindowMinutes: 10,
  rawTextRetentionDays: 30,
} as const

/** Chrome extension origins: 32 characters from a-p. */
export const CAPTURE_EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/

/** The conversation state a reported page problem moves a conversation into. */
export function captureStateForProblem(problem: CaptureProblemState): CaptureState {
  switch (problem) {
    case 'signed_out':
      return 'signed_out'
    case 'challenge':
      return 'needs_attention'
    case 'structure_changed':
      return 'structure_changed'
  }
}
