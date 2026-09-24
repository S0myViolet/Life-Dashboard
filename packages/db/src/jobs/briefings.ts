/**
 * public.briefings access. Writes are service-only (the dispatcher); reads work
 * in either a service transaction or an owner transaction (RLS: owner_read).
 */
import {
  BriefingContentSchema,
  BriefingSourceFreshnessSchema,
  CalendarDateSchema,
  IanaTimeZoneSchema,
  type BriefingContent,
  type BriefingKind,
  type BriefingSourceFreshness,
  type BriefingStatus,
} from '@personal-home/core'
import type { Tx } from '../client.ts'
import { jobsJsonb } from './json.ts'

export interface BriefingRow {
  id: string
  kind: BriefingKind
  localDate: string
  timezone: string
  scheduledFor: Date
  status: BriefingStatus
  publishedAt: Date | null
  isLate: boolean
  notify: boolean
  content: Record<string, unknown>
  sourceFreshness: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface BriefingKey {
  kind: BriefingKind
  localDate: string
}

/**
 * Insert the (kind, localDate) row in `preparing`, or return the existing one.
 * The unique key makes this safe across retries and concurrent workers; an
 * existing row keeps its original timezone/scheduled_for.
 */
export async function insertOrGetBriefing(
  tx: Tx,
  input: BriefingKey & { timezone: string; scheduledFor: Date },
): Promise<{ briefing: BriefingRow; created: boolean }> {
  const localDate = CalendarDateSchema.parse(input.localDate)
  const timezone = IanaTimeZoneSchema.parse(input.timezone)
  const inserted = await tx<BriefingRow[]>`
    insert into public.briefings (kind, local_date, timezone, scheduled_for, status)
    values (${input.kind}, ${localDate}::date, ${timezone}, ${input.scheduledFor}::timestamptz, 'preparing')
    on conflict (kind, local_date) do nothing
    returning *
  `
  if (inserted[0]) return { briefing: inserted[0], created: true }
  const existing = await getBriefing(tx, { kind: input.kind, localDate })
  if (!existing) throw new Error('briefing row vanished after a conflicting insert')
  return { briefing: existing, created: false }
}

/**
 * Publish a briefing unless it is already published. Returns the published row,
 * or null when another attempt/worker published it first.
 */
export async function publishBriefing(
  tx: Tx,
  input: {
    id: string
    publishedAt: Date
    isLate: boolean
    notify: boolean
    content: BriefingContent
    sourceFreshness: BriefingSourceFreshness
  },
): Promise<BriefingRow | null> {
  const content = BriefingContentSchema.parse(input.content)
  const freshness = BriefingSourceFreshnessSchema.parse(input.sourceFreshness)
  // A late briefing never notifies (brief §7: no backlog of old push notifications).
  const notify = input.notify && !input.isLate
  const rows = await tx<BriefingRow[]>`
    update public.briefings set
      status = 'published',
      published_at = ${input.publishedAt}::timestamptz,
      is_late = ${input.isLate},
      notify = ${notify},
      content = ${jobsJsonb(tx, content)}::jsonb,
      source_freshness = ${jobsJsonb(tx, freshness)}::jsonb
    where id = ${input.id}::uuid and status <> 'published'
    returning *
  `
  return rows[0] ?? null
}

/** Mark a still-preparing briefing as failed (never overwrites a published one). */
export async function markBriefingFailed(
  tx: Tx,
  key: BriefingKey,
  reason: { code: string; message: string },
): Promise<boolean> {
  const localDate = CalendarDateSchema.parse(key.localDate)
  const rows = await tx`
    update public.briefings set
      status = 'failed',
      notify = false,
      content = ${jobsJsonb(tx, { version: 1, failure: { code: reason.code, message: reason.message } })}::jsonb
    where kind = ${key.kind} and local_date = ${localDate}::date and status = 'preparing'
    returning id
  `
  return rows.length > 0
}

export async function getBriefing(tx: Tx, key: BriefingKey): Promise<BriefingRow | null> {
  const [row] = await tx<BriefingRow[]>`
    select * from public.briefings where kind = ${key.kind} and local_date = ${key.localDate}::date
  `
  return row ?? null
}

/** Most recent briefings first. Under withOwner, RLS limits this to the owner. */
export async function listRecentBriefings(tx: Tx, limit = 14): Promise<BriefingRow[]> {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 200)
  const rows = await tx<BriefingRow[]>`
    select * from public.briefings order by local_date desc, kind desc limit ${n}
  `
  return [...rows]
}

/** The latest published briefing (optionally of one kind), e.g. for Home. */
export async function getLatestPublishedBriefing(tx: Tx, kind?: BriefingKind): Promise<BriefingRow | null> {
  const [row] = await tx<BriefingRow[]>`
    select * from public.briefings
    where status = 'published' and (${kind ?? null}::text is null or kind = ${kind ?? null})
    order by scheduled_for desc
    limit 1
  `
  return row ?? null
}
