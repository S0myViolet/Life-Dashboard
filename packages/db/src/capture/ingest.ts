/**
 * Snapshot ingestion. Service transaction, called only after the device token
 * and origin were verified. The conversation row is locked for the whole
 * transaction, so concurrent uploads for one conversation apply one at a time
 * and a duplicate upload sees the first one's result.
 */
import {
  capturePrepareSnapshot,
  captureReconcile,
  captureSanitizeText,
  captureSortMessages,
  type CaptureOp,
  type CaptureSnapshot,
  type CaptureSnapshotOutcome,
  type CaptureState,
  type CaptureStoredConversation,
  type CaptureStoredMessage,
  type CaptureStoredVersion,
} from '@personal-home/core'
import type { Tx } from '../client.ts'

export type CaptureIngestResult =
  | { status: 'not_selected' }
  | { status: 'not_active'; captureState: CaptureState }
  | {
      status: 'ok'
      outcome: CaptureSnapshotOutcome
      reason: string | null
      newMessages: number
      newVersions: number
      captureState: CaptureState
      /** The same snapshotId was already processed; its original result is returned. */
      duplicate: boolean
      contentChanged: boolean
    }

const iso = (d: Date | null) => (d === null ? null : d.toISOString())

interface StoredWithIds {
  conversation: CaptureStoredConversation
  ids: Map<string, string>
}

async function loadStored(tx: Tx, conversationId: string): Promise<StoredWithIds> {
  const messages = await tx<
    {
      id: string
      messageKey: string
      keySource: 'provider' | 'derived'
      role: 'user' | 'assistant'
      orderHint: number
      orderObservedAt: Date | null
      firstSeenAt: Date
      lastSeenAt: Date
      currentHash: string | null
    }[]
  >`
    select m.id, m.message_key, m.key_source, m.role, m.order_hint, m.order_observed_at,
           m.first_seen_at, m.last_seen_at, cv.content_hash as current_hash
    from public.captured_messages m
    left join public.captured_message_versions cv on cv.id = m.current_version_id
    where m.conversation_id = ${conversationId}
  `
  const versions = await tx<
    {
      messageId: string
      contentHash: string
      capturedAt: Date
      lastObservedAt: Date
      supersededAt: Date | null
    }[]
  >`
    select v.message_id, v.content_hash, v.captured_at, v.last_observed_at, v.superseded_at
    from public.captured_message_versions v
    join public.captured_messages m on m.id = v.message_id
    where m.conversation_id = ${conversationId}
    order by v.captured_at, v.content_hash
  `
  const byMessage = new Map<string, CaptureStoredVersion[]>()
  for (const v of versions) {
    const list = byMessage.get(v.messageId) ?? []
    list.push({
      contentHash: v.contentHash,
      capturedAt: v.capturedAt.toISOString(),
      lastObservedAt: v.lastObservedAt.toISOString(),
      supersededAt: iso(v.supersededAt),
    })
    byMessage.set(v.messageId, list)
  }
  const ids = new Map<string, string>()
  const stored: CaptureStoredMessage[] = messages.map((m) => {
    ids.set(m.messageKey, m.id)
    return {
      key: m.messageKey,
      keySource: m.keySource,
      role: m.role,
      orderHint: m.orderHint,
      orderObservedAt: iso(m.orderObservedAt),
      firstSeenAt: m.firstSeenAt.toISOString(),
      lastSeenAt: m.lastSeenAt.toISOString(),
      currentHash: m.currentHash,
      versions: byMessage.get(m.id) ?? [],
    }
  })
  return { conversation: { messages: captureSortMessages(stored) }, ids }
}

/** Stored state in the same shape the pure reconcile model uses (tests, M2 summaries). */
export async function captureLoadConversationState(
  tx: Tx,
  conversationId: string,
): Promise<CaptureStoredConversation> {
  return (await loadStored(tx, conversationId)).conversation
}

const json = (rows: unknown[]) => JSON.stringify(rows)
const codePoints = (s: string) => {
  let n = 0
  for (const _ of s) n++
  return n
}

type OpOf<K extends CaptureOp['kind']> = Extract<CaptureOp, { kind: K }>

/** Apply reconcile operations in bulk, one statement per operation kind. */
async function applyOps(tx: Tx, conversationId: string, ops: CaptureOp[], ids: Map<string, string>) {
  const of = <K extends CaptureOp['kind']>(kind: K) => ops.filter((o): o is OpOf<K> => o.kind === kind)
  const id = (key: string) => {
    const v = ids.get(key)
    if (!v) throw new Error('capture op refers to an unknown message')
    return v
  }

  const inserts = of('insert_message')
  if (inserts.length > 0) {
    const rows = await tx<{ id: string; messageKey: string }[]>`
      insert into public.captured_messages
        (conversation_id, message_key, key_source, role, order_hint, order_observed_at,
         first_seen_at, last_seen_at)
      select ${conversationId}::uuid, r.key, r.key_source, r.role, r.order_hint,
             r.order_observed_at, r.seen_at, r.seen_at
      from jsonb_to_recordset(${json(
        inserts.map((o) => ({
          key: o.key,
          key_source: o.keySource,
          role: o.role,
          order_hint: o.orderHint,
          order_observed_at: o.orderObservedAt,
          seen_at: o.seenAt,
        })),
      )}::text::jsonb) as r(key text, key_source text, role text, order_hint double precision,
                      order_observed_at timestamptz, seen_at timestamptz)
      on conflict (conversation_id, message_key) do nothing
      returning id, message_key
    `
    for (const r of rows) ids.set(r.messageKey, r.id)
  }

  const versions = of('insert_version')
  if (versions.length > 0) {
    await tx`
      insert into public.captured_message_versions
        (message_id, content_hash, text, char_count, captured_at, last_observed_at)
      select r.message_id, r.content_hash, r.text, r.char_count, r.captured_at, r.captured_at
      from jsonb_to_recordset(${json(
        versions.map((o) => ({
          message_id: id(o.key),
          content_hash: o.contentHash,
          text: o.text,
          char_count: codePoints(o.text),
          captured_at: o.capturedAt,
        })),
      )}::text::jsonb) as r(message_id uuid, content_hash text, text text, char_count integer,
                      captured_at timestamptz)
      on conflict (message_id, content_hash) do nothing
    `
  }

  const observed = of('observe_version')
  if (observed.length > 0) {
    await tx`
      update public.captured_message_versions v
      set captured_at = least(v.captured_at, r.captured_at),
          last_observed_at = greatest(v.last_observed_at, r.last_observed_at)
      from jsonb_to_recordset(${json(
        observed.map((o) => ({
          message_id: id(o.key),
          content_hash: o.contentHash,
          captured_at: o.capturedAt,
          last_observed_at: o.lastObservedAt,
        })),
      )}::text::jsonb) as r(message_id uuid, content_hash text, captured_at timestamptz,
                      last_observed_at timestamptz)
      where v.message_id = r.message_id and v.content_hash = r.content_hash
    `
  }

  const touched = of('touch_message')
  if (touched.length > 0) {
    await tx`
      update public.captured_messages m
      set first_seen_at = least(m.first_seen_at, r.first_seen_at),
          last_seen_at = greatest(m.last_seen_at, r.last_seen_at)
      from jsonb_to_recordset(${json(
        touched.map((o) => ({
          id: id(o.key),
          first_seen_at: o.firstSeenAt,
          last_seen_at: o.lastSeenAt,
        })),
      )}::text::jsonb) as r(id uuid, first_seen_at timestamptz, last_seen_at timestamptz)
      where m.id = r.id
    `
  }

  const ordered = of('set_order')
  if (ordered.length > 0) {
    await tx`
      update public.captured_messages m
      set order_hint = r.order_hint, order_observed_at = r.order_observed_at
      from jsonb_to_recordset(${json(
        ordered.map((o) => ({
          id: id(o.key),
          order_hint: o.orderHint,
          order_observed_at: o.orderObservedAt,
        })),
      )}::text::jsonb) as r(id uuid, order_hint double precision, order_observed_at timestamptz)
      where m.id = r.id
    `
  }

  const superseded = of('set_superseded')
  if (superseded.length > 0) {
    await tx`
      update public.captured_message_versions v
      set superseded_at = r.superseded_at
      from jsonb_to_recordset(${json(
        superseded.map((o) => ({
          message_id: id(o.key),
          content_hash: o.contentHash,
          superseded_at: o.supersededAt,
        })),
      )}::text::jsonb) as r(message_id uuid, content_hash text, superseded_at timestamptz)
      where v.message_id = r.message_id and v.content_hash = r.content_hash
    `
  }

  const current = of('set_current')
  if (current.length > 0) {
    await tx`
      update public.captured_messages m
      set current_version_id = v.id
      from jsonb_to_recordset(${json(
        current.map((o) => ({ message_id: id(o.key), content_hash: o.contentHash })),
      )}::text::jsonb) as r(message_id uuid, content_hash text)
      join public.captured_message_versions v
        on v.message_id = r.message_id and v.content_hash = r.content_hash
      where m.id = r.message_id
    `
  }
}

/**
 * Apply one validated snapshot to a selected, active conversation and record it.
 * Never deletes messages; see captureReconcile for the rules.
 */
export async function captureIngestSnapshot(
  tx: Tx,
  snapshot: CaptureSnapshot,
  options: { receivedAt?: Date } = {},
): Promise<CaptureIngestResult> {
  const receivedAt = options.receivedAt ?? new Date()
  const [conv] = await tx<{ id: string; captureState: CaptureState }[]>`
    select id, capture_state from public.conversations
    where provider = ${snapshot.provider}
      and external_id = ${snapshot.conversation.externalId.toLowerCase()}::uuid
    for update
  `
  if (!conv) return { status: 'not_selected' }

  const [previous] = await tx<
    { outcome: CaptureSnapshotOutcome; reason: string | null; newMessages: number; newVersions: number }[]
  >`
    select outcome, reason, new_messages, new_versions from public.capture_snapshots
    where conversation_id = ${conv.id} and client_snapshot_id = ${snapshot.snapshotId}::uuid
  `
  if (previous) {
    return {
      status: 'ok',
      ...previous,
      captureState: conv.captureState,
      duplicate: true,
      contentChanged: false,
    }
  }
  if (conv.captureState !== 'active') {
    return { status: 'not_active', captureState: conv.captureState }
  }

  const prepared = await capturePrepareSnapshot(snapshot, { receivedAt })
  const { conversation: stored, ids } = await loadStored(tx, conv.id)
  const plan = captureReconcile(stored, prepared)
  if (plan.ops.length > 0) await applyOps(tx, conv.id, plan.ops, ids)

  let captureState: CaptureState = conv.captureState
  if (plan.nextCaptureState) {
    captureState = plan.nextCaptureState
    await tx`
      update public.conversations
      set capture_state = ${captureState}, state_reason = ${plan.reason}, state_changed_at = ${receivedAt}
      where id = ${conv.id}
    `
  } else if (plan.outcome === 'applied') {
    const capturedAt = prepared.capturedAt
    await tx`
      update public.conversations
      set last_captured_at = greatest(last_captured_at, ${capturedAt}::timestamptz),
          last_seen_complete_at = case when ${plan.complete}
            then greatest(last_seen_complete_at, ${capturedAt}::timestamptz)
            else last_seen_complete_at end,
          -- An older snapshot delivered late never overwrites a newer title.
          title = case when ${capturedAt}::timestamptz >= coalesce(last_captured_at, '-infinity')
            then coalesce(${captureSanitizeText(snapshot.conversation.title ?? '').trim() || null}, title) else title end,
          content_changed_at = case when ${plan.contentChanged}
            then ${receivedAt} else content_changed_at end,
          message_count = (
            select count(*)::int from public.captured_messages where conversation_id = ${conv.id}
          )
      where id = ${conv.id}
    `
  }

  await tx`
    insert into public.capture_snapshots
      (conversation_id, client_snapshot_id, captured_at, received_at, coverage, mode,
       message_count, outcome, reason, new_messages, new_versions, extension_version)
    values (
      ${conv.id}, ${snapshot.snapshotId}::uuid, ${prepared.capturedAt}, ${receivedAt},
      ${JSON.stringify(snapshot.coverage)}::text::jsonb, ${snapshot.coverage.mode},
      ${snapshot.messages.length}, ${plan.outcome}, ${plan.reason},
      ${plan.stats.newMessages}, ${plan.stats.newVersions}, ${snapshot.extensionVersion}
    )
  `

  return {
    status: 'ok',
    outcome: plan.outcome,
    reason: plan.reason,
    newMessages: plan.stats.newMessages,
    newVersions: plan.stats.newVersions,
    captureState,
    duplicate: false,
    contentChanged: plan.contentChanged,
  }
}
