/**
 * Selected conversations.
 *
 * Owner functions (withOwner, RLS enforced): select/attach, list, pause/resume, remove.
 * Device functions (withService, after token verification): list the active selection,
 * mark a reported page problem.
 */
import {
  CAPTURE_UUID_RE,
  captureParseConversationUrl,
  captureStateForProblem,
  type CaptureCoverage,
  type CaptureMode,
  type CaptureProblemState,
  type CaptureProvider,
  type CaptureSelectionItem,
  type CaptureSnapshotOutcome,
  type CaptureState,
} from '@personal-home/core'
import type { Tx } from '../client.ts'
import { projectExists } from './projects.ts'

export interface CaptureConversationRef {
  id: string
  provider: CaptureProvider
  externalId: string
  url: string
  captureState: CaptureState
}

export type CaptureSelectResult =
  | { status: 'selected'; created: boolean; conversation: CaptureConversationRef }
  | { status: 'invalid_url' }
  | { status: 'unknown_project' }

/**
 * Owner selects a conversation (and optionally attaches it to a project).
 * Selecting an already-selected conversation updates its project and resumes it.
 */
export async function captureSelectConversation(
  tx: Tx,
  input: { url: string; projectId?: string | null },
): Promise<CaptureSelectResult> {
  const ref = captureParseConversationUrl(input.url)
  if (!ref) return { status: 'invalid_url' }
  const projectId = input.projectId ?? null
  if (projectId !== null && !(await projectExists(tx, projectId))) {
    return { status: 'unknown_project' }
  }
  const [row] = await tx<(CaptureConversationRef & { created: boolean })[]>`
    insert into public.conversations (provider, external_id, url, project_id, state_reason, state_changed_at)
    values (${ref.provider}, ${ref.externalId}::uuid, ${ref.canonicalUrl}, ${projectId}::uuid, 'owner', now())
    on conflict (provider, external_id) do update
      set project_id = excluded.project_id,
          url = excluded.url,
          capture_state = 'active',
          state_reason = 'owner',
          state_changed_at = case
            when public.conversations.capture_state <> 'active' then now()
            else public.conversations.state_changed_at
          end
    returning id, provider, external_id::text as external_id, url, capture_state,
              (xmax = 0) as created
  `
  if (!row) throw new Error('conversation upsert returned no row')
  const { created, ...conversation } = row
  return { status: 'selected', created, conversation }
}

export interface CaptureLastSnapshot {
  capturedAt: Date
  receivedAt: Date
  outcome: CaptureSnapshotOutcome
  reason: string | null
  mode: CaptureMode
  coverage: Partial<CaptureCoverage>
  messageCount: number
  newMessages: number
  newVersions: number
}

export interface CaptureConversationRow extends CaptureConversationRef {
  title: string | null
  projectId: string | null
  projectName: string | null
  selectedAt: Date
  stateReason: string | null
  stateChangedAt: Date | null
  lastCapturedAt: Date | null
  lastSeenCompleteAt: Date | null
  contentChangedAt: Date | null
  messageCount: number
  /** Latest snapshot of any outcome (coverage only; never message text). */
  lastSnapshot: CaptureLastSnapshot | null
}

/** Owner view of every selected conversation, newest selection first. */
export async function captureListConversations(
  tx: Tx,
  filter: { projectId?: string } = {},
): Promise<CaptureConversationRow[]> {
  const projectId = filter.projectId ?? null
  if (projectId !== null && !CAPTURE_UUID_RE.test(projectId)) return []
  const rows = await tx<(Omit<CaptureConversationRow, 'lastSnapshot'> & { lastSnapshot: unknown })[]>`
    select c.id, c.provider, c.external_id::text as external_id, c.url, c.title,
           c.project_id, p.name as project_name, c.selected_at, c.capture_state,
           c.state_reason, c.state_changed_at, c.last_captured_at, c.last_seen_complete_at,
           c.content_changed_at, c.message_count,
           (
             select jsonb_build_object(
               'captured_at', s.captured_at, 'received_at', s.received_at,
               'outcome', s.outcome, 'reason', s.reason, 'mode', s.mode,
               'coverage', s.coverage, 'message_count', s.message_count,
               'new_messages', s.new_messages, 'new_versions', s.new_versions
             )
             from public.capture_snapshots s
             where s.conversation_id = c.id
             order by s.received_at desc, s.created_at desc, s.id desc
             limit 1
           ) as last_snapshot
    from public.conversations c
    left join public.projects p on p.id = c.project_id
    where ${projectId}::uuid is null or c.project_id = ${projectId}::uuid
    order by c.selected_at desc, c.id
  `
  return rows.map((r) => ({ ...r, lastSnapshot: toLastSnapshot(r.lastSnapshot) }))
}

function toLastSnapshot(value: unknown): CaptureLastSnapshot | null {
  if (!value || typeof value !== 'object') return null
  // jsonb keys arrive camelCased by the client transform.
  const v = value as Record<string, unknown>
  return {
    capturedAt: new Date(String(v.capturedAt)),
    receivedAt: new Date(String(v.receivedAt)),
    outcome: v.outcome as CaptureSnapshotOutcome,
    reason: (v.reason as string | null) ?? null,
    mode: v.mode as CaptureMode,
    coverage: (v.coverage as Partial<CaptureCoverage>) ?? {},
    messageCount: Number(v.messageCount ?? 0),
    newMessages: Number(v.newMessages ?? 0),
    newVersions: Number(v.newVersions ?? 0),
  }
}

/** Owner pause/resume. Resume clears any problem state (the owner's "Reconnect"). */
export async function captureSetConversationPaused(
  tx: Tx,
  conversationId: string,
  paused: boolean,
): Promise<CaptureConversationRef | null> {
  if (!CAPTURE_UUID_RE.test(conversationId)) return null
  const next: CaptureState = paused ? 'paused' : 'active'
  const [row] = await tx<CaptureConversationRef[]>`
    update public.conversations
    set capture_state = ${next}, state_reason = 'owner', state_changed_at = now()
    where id = ${conversationId}::uuid
    returning id, provider, external_id::text as external_id, url, capture_state
  `
  return row ?? null
}

/** Owner removes a conversation: its messages, versions and snapshot log go with it. */
export async function captureRemoveConversation(tx: Tx, conversationId: string): Promise<boolean> {
  if (!CAPTURE_UUID_RE.test(conversationId)) return false
  const rows = await tx`delete from public.conversations where id = ${conversationId}::uuid returning id`
  return rows.length > 0
}

/** Owner moves a conversation to another project (or none). */
export async function captureSetConversationProject(
  tx: Tx,
  conversationId: string,
  projectId: string | null,
): Promise<boolean> {
  if (!CAPTURE_UUID_RE.test(conversationId)) return false
  if (projectId !== null && !(await projectExists(tx, projectId))) return false
  const rows = await tx`
    update public.conversations set project_id = ${projectId}::uuid
    where id = ${conversationId}::uuid returning id
  `
  return rows.length > 0
}

/**
 * The selection a paired device may collect: active conversations only, and
 * only the fields the helper needs. Service transaction after token verification.
 */
export async function captureListSelection(tx: Tx): Promise<CaptureSelectionItem[]> {
  return tx<CaptureSelectionItem[]>`
    select id, provider, external_id::text as external_id, url, capture_state
    from public.conversations
    where capture_state = 'active'
    order by selected_at, id
  `
}

export type CaptureMarkStateResult =
  | { status: 'not_selected' }
  | { status: 'unchanged'; captureState: CaptureState }
  | { status: 'updated'; captureState: CaptureState }

/**
 * The helper reported a problem on a selected conversation's page. The
 * conversation stops being collected (last good data is kept) until the owner
 * resumes it. An owner pause is never overridden.
 */
export async function captureMarkState(
  tx: Tx,
  input: { provider: CaptureProvider; externalId: string; problem: CaptureProblemState; at: Date },
): Promise<CaptureMarkStateResult> {
  if (!CAPTURE_UUID_RE.test(input.externalId)) return { status: 'not_selected' }
  const [row] = await tx<{ id: string; captureState: CaptureState }[]>`
    select id, capture_state from public.conversations
    where provider = ${input.provider} and external_id = ${input.externalId}::uuid
    for update
  `
  if (!row) return { status: 'not_selected' }
  const next = captureStateForProblem(input.problem)
  if (row.captureState === 'paused' || row.captureState === next) {
    return { status: 'unchanged', captureState: row.captureState }
  }
  await tx`
    update public.conversations
    set capture_state = ${next}, state_reason = ${input.problem}, state_changed_at = ${input.at}
    where id = ${row.id}
  `
  return { status: 'updated', captureState: next }
}
