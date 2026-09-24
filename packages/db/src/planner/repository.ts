/**
 * Daily plans and plan blocks.
 *
 * Every function takes a transaction and an explicit `now`. User-facing callers use
 * `withOwner` (RLS applies); jobs may use `withService`. Every mutation of a plan first locks
 * its daily_plans row, so replans and owner actions on the same plan are serialised.
 *
 * Invariants kept here (and backed by table constraints):
 *   - one plan per local date, created idempotently on first use (unique local_date);
 *   - blocks the owner owns (accepted, pinned, done, dismissed, edited) are never changed by a
 *     replan: its updates and deletes are guarded by `state = 'suggested' and not edited_by_owner`;
 *   - non-dismissed timed blocks of a plan never overlap (deferred exclusion constraint).
 */
import {
  CalendarDateSchema,
  addLocalDays,
  isoWeekday,
  localDateInZone,
  planDay,
  plannerAssignPositions,
  plannerAvailabilityForWeekday,
  plannerCandidateKey,
  plannerDismissedKeys,
  plannerProtectedBlocksOf,
  plannerValidateBlockEdit,
  plannerValidateMove,
  plannerValidateRestore,
  reviseDraft,
  type DailyPlanSource,
  type PlanBlockBucket,
  type PlanBlockState,
  type PlanCurrentBlock,
  type PlanDraft,
  type PlanDraftBlock,
  type PlannerCandidateKind,
  type PlannerEditErrorCode,
  type PlanRevision,
} from '@personal-home/core'
import type postgres from 'postgres'
import type { Tx } from '../client.ts'
import {
  PLANNER_DEFAULT_SOURCES,
  plannerLoadCandidates,
  type PlannerCandidateSource,
} from './candidates.ts'

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface DailyPlanRow {
  id: string
  localDate: string
  timezone: string
  generatedAt: Date
  source: DailyPlanSource
  mode: 'time' | 'list'
  draft: PlanDraft
  status: 'draft' | 'active'
  revision: number
  createdAt: Date
  updatedAt: Date
}

export interface PlanBlockRow {
  id: string
  planId: string
  candidateKind: PlannerCandidateKind
  candidateId: string
  titleSnapshot: string
  bucket: PlanBlockBucket
  startAt: Date | null
  endAt: Date | null
  minutes: number
  position: number
  state: PlanBlockState
  estimated: boolean
  tentative: boolean
  splitPart: number | null
  splitTotal: number | null
  priorityRank: number | null
  note: string | null
  editedByOwner: boolean
  acceptedAt: Date | null
  doneAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface PlannerPlan {
  plan: DailyPlanRow
  /** Ordered: timed blocks by start, then list items by position. */
  blocks: PlanBlockRow[]
}

export interface PlannerSettings {
  timezone: string
  availableHours: unknown
}

export type PlannerActionResult =
  | { ok: true; message?: string }
  | { ok: false; code: PlannerEditErrorCode | 'invalid_state' | 'slot_passed'; message: string }

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function plannerLoadSettings(tx: Tx): Promise<PlannerSettings> {
  const [row] = await tx<{ timezone: string; availableHours: unknown }[]>`
    select timezone, available_hours from public.owner_settings where singleton
  `
  if (!row) throw new Error('owner settings are not readable')
  return { timezone: row.timezone, availableHours: row.availableHours }
}

/** The owner's current local date. */
export async function plannerToday(
  tx: Tx,
  now: Date,
): Promise<{ today: string; timezone: string }> {
  const { timezone } = await plannerLoadSettings(tx)
  return { today: localDateInZone(now, timezone), timezone }
}

function sortBlocks(blocks: PlanBlockRow[]): PlanBlockRow[] {
  return blocks.sort((a, b) => {
    if (a.startAt && b.startAt) {
      return a.startAt.getTime() - b.startAt.getTime() || a.position - b.position
    }
    if (a.startAt) return -1
    if (b.startAt) return 1
    return a.position - b.position || (a.id < b.id ? -1 : 1)
  })
}

async function blocksOf(tx: Tx, planId: string): Promise<PlanBlockRow[]> {
  const rows = await tx<PlanBlockRow[]>`
    select * from public.plan_blocks where plan_id = ${planId}::uuid
  `
  return sortBlocks([...rows])
}

export async function plannerGetPlan(tx: Tx, localDate: string): Promise<PlannerPlan | null> {
  const date = CalendarDateSchema.parse(localDate)
  const [plan] = await tx<DailyPlanRow[]>`
    select * from public.daily_plans where local_date = ${date}::date
  `
  if (!plan) return null
  return { plan, blocks: await blocksOf(tx, plan.id) }
}

async function lockPlan(tx: Tx, localDate: string): Promise<DailyPlanRow | null> {
  const [plan] = await tx<DailyPlanRow[]>`
    select * from public.daily_plans where local_date = ${localDate}::date for update
  `
  return plan ?? null
}

async function lockPlanOfBlock(tx: Tx, blockId: string): Promise<DailyPlanRow | null> {
  const [plan] = await tx<DailyPlanRow[]>`
    select p.* from public.daily_plans p
    where p.id = (select b.plan_id from public.plan_blocks b where b.id = ${blockId}::uuid)
    for update
  `
  return plan ?? null
}

/** The shape core planner functions work with. */
export function plannerCurrentBlock(b: PlanBlockRow): PlanCurrentBlock {
  return {
    id: b.id,
    candidateKind: b.candidateKind,
    candidateId: b.candidateId,
    title: b.titleSnapshot,
    bucket: b.bucket,
    start: b.startAt ? b.startAt.toISOString() : null,
    end: b.endAt ? b.endAt.toISOString() : null,
    minutes: b.minutes,
    state: b.state,
    editedByOwner: b.editedByOwner,
    splitPart: b.splitPart,
    splitTotal: b.splitTotal,
    position: b.position,
    tentative: b.tentative,
    estimated: b.estimated,
  }
}

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

export interface PlannerDraftOptions {
  now: Date
  localDate: string
  /** Defaults to the saved owner settings. */
  settings?: PlannerSettings
  sources?: readonly PlannerCandidateSource[]
}

/**
 * Compute a fresh draft for `localDate` from saved data, around the plan's current
 * owner-owned blocks (which are protected and never re-suggested).
 */
export async function plannerComputeDraft(
  tx: Tx,
  opts: PlannerDraftOptions & { current?: readonly PlanCurrentBlock[] },
): Promise<PlanDraft> {
  const settings = opts.settings ?? (await plannerLoadSettings(tx))
  const timezone = settings.timezone
  const localDate = CalendarDateSchema.parse(opts.localDate)
  const current = opts.current ?? []
  const availability = plannerAvailabilityForWeekday(settings.availableHours, isoWeekday(localDate))
  const loaded = await plannerLoadCandidates(
    tx,
    { localDate, timezone, now: opts.now },
    opts.sources ?? PLANNER_DEFAULT_SOURCES,
  )
  const dismissed = plannerDismissedKeys(current)
  const draft = planDay({
    now: opts.now,
    timezone,
    localDate,
    availability: availability.windows,
    listModeReason: availability.listModeReason,
    // Calendar busy time arrives in Milestone 2; until then the draft says so (calendarStatus).
    busy: [],
    calendarStatus: 'not_connected',
    protectedBlocks: plannerProtectedBlocksOf(current),
    candidates: loaded.candidates.filter((c) => !dismissed.has(plannerCandidateKey(c.kind, c.id))),
  })
  if (loaded.failedSources.length > 0) {
    draft.notes.push({
      code: 'sources_partial',
      message: `Some items could not be read (${loaded.failedSources.join(', ')}), so this plan may be incomplete.`,
    })
  }
  return draft
}

/** Draft blocks in display order: timed blocks by start, then list items in rank order. */
function draftBlocksInOrder(draft: PlanDraft): PlanDraftBlock[] {
  const timed = [...draft.scheduled, ...draft.smallTasks].sort((a, b) =>
    a.start! < b.start! ? -1 : a.start! > b.start! ? 1 : 0,
  )
  return [...timed, ...draft.list]
}

async function insertBlocks(
  tx: Tx,
  planId: string,
  blocks: readonly PlanDraftBlock[],
  positions: readonly number[],
): Promise<void> {
  if (blocks.length === 0) return
  const rows = blocks.map((b, i) => ({
    planId,
    candidateKind: b.candidateKind,
    candidateId: b.candidateId,
    titleSnapshot: b.title,
    bucket: b.bucket,
    startAt: b.start,
    endAt: b.end,
    minutes: b.minutes,
    position: positions[i]!,
    state: 'suggested',
    estimated: b.estimated,
    tentative: b.tentative,
    splitPart: b.splitPart,
    splitTotal: b.splitTotal,
    priorityRank: b.priorityRank,
    note: b.note,
  }))
  await tx`insert into public.plan_blocks ${tx(rows)}`
}

/**
 * Return the plan for `localDate`, creating it from saved data when none exists.
 * Safe under concurrent calls: the unique local_date makes the second insert wait for the first
 * and then do nothing, after which it reads the committed plan.
 */
export async function plannerEnsurePlan(
  tx: Tx,
  opts: PlannerDraftOptions & { source: DailyPlanSource },
): Promise<{ plan: PlannerPlan; created: boolean }> {
  const localDate = CalendarDateSchema.parse(opts.localDate)
  const existing = await plannerGetPlan(tx, localDate)
  if (existing) return { plan: existing, created: false }

  const settings = opts.settings ?? (await plannerLoadSettings(tx))
  const draft = await plannerComputeDraft(tx, { ...opts, localDate, settings })
  const [inserted] = await tx<{ id: string }[]>`
    insert into public.daily_plans (local_date, timezone, generated_at, source, mode, draft)
    values (${localDate}::date, ${settings.timezone}, ${opts.now}::timestamptz, ${opts.source},
            ${draft.mode}, ${tx.json(draft as unknown as postgres.JSONValue)})
    on conflict (local_date) do nothing
    returning id
  `
  if (!inserted) {
    const winner = await plannerGetPlan(tx, localDate)
    if (!winner) throw new Error('daily plan vanished after a conflicting insert')
    return { plan: winner, created: false }
  }
  const ordered = draftBlocksInOrder(draft)
  await insertBlocks(
    tx,
    inserted.id,
    ordered,
    ordered.map((_, i) => i),
  )
  const plan = await plannerGetPlan(tx, localDate)
  if (!plan) throw new Error('daily plan not readable after insert')
  return { plan, created: true }
}

/** Today's plan, drafted on first use each local day ("auto_first_use"). */
export async function plannerEnsureTodayPlan(
  tx: Tx,
  opts: { now: Date; sources?: readonly PlannerCandidateSource[] },
): Promise<{ plan: PlannerPlan; created: boolean; today: string }> {
  const settings = await plannerLoadSettings(tx)
  const today = localDateInZone(opts.now, settings.timezone)
  const result = await plannerEnsurePlan(tx, {
    now: opts.now,
    localDate: today,
    settings,
    source: 'auto_first_use',
    sources: opts.sources,
  })
  return { ...result, today }
}

/**
 * What a replan would change right now, without changing anything. Used to tell the owner
 * that their data changed since the draft (a proposed revision, never a silent replacement).
 */
export async function plannerPreviewRevision(
  tx: Tx,
  opts: { now: Date; localDate: string; sources?: readonly PlannerCandidateSource[] },
): Promise<PlanRevision | null> {
  const existing = await plannerGetPlan(tx, opts.localDate)
  if (!existing) return null
  const current = existing.blocks.map(plannerCurrentBlock)
  const draft = await plannerComputeDraft(tx, { ...opts, current })
  return reviseDraft(current, draft)
}

/**
 * "Plan my day" / "Replan remaining day": draft again from now on, keep every owner-owned block
 * exactly as it is, and apply the revision to the planner's own unaccepted suggestions.
 */
export async function plannerReplan(
  tx: Tx,
  opts: { now: Date; localDate: string; sources?: readonly PlannerCandidateSource[] },
): Promise<{ plan: PlannerPlan; revision: PlanRevision | null; created: boolean }> {
  const localDate = CalendarDateSchema.parse(opts.localDate)
  const locked = await lockPlan(tx, localDate)
  if (!locked) {
    const { plan, created } = await plannerEnsurePlan(tx, { ...opts, localDate, source: 'manual' })
    if (created) return { plan, revision: null, created }
    // Another request created it between our read and insert: replan that one.
    return plannerReplan(tx, opts)
  }
  const settings = await plannerLoadSettings(tx)
  const blocks = await blocksOf(tx, locked.id)
  const current = blocks.map(plannerCurrentBlock)
  const draft = await plannerComputeDraft(tx, { ...opts, localDate, settings, current })
  const revision = reviseDraft(current, draft)

  // Remaining suggestions in display order, then positions that leave owner-kept ones alone.
  const order = new Map(draftBlocksInOrder(draft).map((b, i) => [b, i]))
  const finals: Array<{ blockId: string | null; block: PlanDraftBlock }> = [
    ...revision.unchanged.map((u) => ({ blockId: u.blockId, block: u.block })),
    ...revision.moves.map((m) => ({ blockId: m.blockId, block: m.to })),
    ...revision.additions.map((a) => ({ blockId: null, block: a })),
  ].sort((a, b) => (order.get(a.block) ?? 0) - (order.get(b.block) ?? 0))
  const positions = plannerAssignPositions(
    revision.kept.filter((b) => b.state !== 'dismissed').map((b) => b.position),
    finals.length,
  )

  for (const r of revision.removals) {
    await tx`
      delete from public.plan_blocks
      where id = ${r.blockId}::uuid and state = 'suggested' and not edited_by_owner
    `
  }
  const additions: PlanDraftBlock[] = []
  const additionPositions: number[] = []
  for (const [i, f] of finals.entries()) {
    const b = f.block
    if (f.blockId === null) {
      additions.push(b)
      additionPositions.push(positions[i]!)
      continue
    }
    await tx`
      update public.plan_blocks set
        title_snapshot = ${b.title},
        bucket = ${b.bucket},
        start_at = ${b.start}::timestamptz,
        end_at = ${b.end}::timestamptz,
        minutes = ${b.minutes},
        position = ${positions[i]!},
        estimated = ${b.estimated},
        tentative = ${b.tentative},
        split_part = ${b.splitPart},
        split_total = ${b.splitTotal},
        priority_rank = ${b.priorityRank},
        note = ${b.note}
      where id = ${f.blockId}::uuid and state = 'suggested' and not edited_by_owner
    `
  }
  await insertBlocks(tx, locked.id, additions, additionPositions)
  await tx`
    update public.daily_plans set
      draft = ${tx.json(draft as unknown as postgres.JSONValue)},
      mode = ${draft.mode},
      timezone = ${settings.timezone},
      generated_at = ${opts.now}::timestamptz,
      source = 'replan',
      revision = revision + 1
    where id = ${locked.id}::uuid
  `
  const plan = await plannerGetPlan(tx, localDate)
  if (!plan) throw new Error('daily plan not readable after replan')
  return { plan, revision, created: false }
}

// ---------------------------------------------------------------------------
// Owner actions on blocks
// ---------------------------------------------------------------------------

export type PlannerBlockAction = 'accept' | 'pin' | 'unpin' | 'dismiss' | 'restore' | 'done'

const TASK_KINDS: readonly PlannerCandidateKind[] = ['task', 'project_action', 'email_deadline']

async function bumpPlan(tx: Tx, planId: string, activate: boolean): Promise<void> {
  await tx`
    update public.daily_plans set
      revision = revision + 1,
      status = case when ${activate} then 'active' else status end
    where id = ${planId}::uuid
  `
}

function editContext(plan: DailyPlanRow, blocks: PlanBlockRow[], now: Date) {
  return {
    timezone: plan.timezone,
    localDate: plan.localDate,
    now,
    blocks: blocks.map(plannerCurrentBlock),
    busy: [],
  }
}

const invalid = (message: string): PlannerActionResult => ({
  ok: false,
  code: 'invalid_state',
  message,
})

/**
 * Accept, pin, unpin, dismiss, restore or mark done one block. Acceptance creates/marks local
 * plan blocks only; nothing is written to an external calendar.
 *
 * Marking the last open block of a task done also completes the task (status 'done'); for a
 * habit it records today's completion. Parts of a split task complete the task only when every
 * other part in the plan is done too.
 */
export async function plannerApplyBlockAction(
  tx: Tx,
  opts: { now: Date; blockId: string; action: PlannerBlockAction },
): Promise<PlannerActionResult> {
  const plan = await lockPlanOfBlock(tx, opts.blockId)
  if (!plan) return { ok: false, code: 'not_found', message: 'That plan item no longer exists.' }
  const blocks = await blocksOf(tx, plan.id)
  const block = blocks.find((b) => b.id === opts.blockId)
  if (!block) return { ok: false, code: 'not_found', message: 'That plan item no longer exists.' }
  const now = opts.now
  const slotPassed = block.endAt !== null && block.endAt.getTime() <= now.getTime()

  switch (opts.action) {
    case 'accept': {
      if (block.state !== 'suggested') return invalid('Only suggestions can be accepted.')
      if (slotPassed) {
        return {
          ok: false,
          code: 'slot_passed',
          message: 'This time has passed. Edit its time or replan the day.',
        }
      }
      await tx`
        update public.plan_blocks set state = 'accepted', accepted_at = ${now}::timestamptz
        where id = ${block.id}::uuid
      `
      await bumpPlan(tx, plan.id, true)
      return { ok: true }
    }
    case 'pin': {
      if (block.state !== 'suggested' && block.state !== 'accepted') {
        return invalid('Only suggestions and accepted items can be pinned.')
      }
      if (block.state === 'suggested' && slotPassed) {
        return {
          ok: false,
          code: 'slot_passed',
          message: 'This time has passed. Edit its time or replan the day.',
        }
      }
      await tx`
        update public.plan_blocks
        set state = 'pinned', accepted_at = coalesce(accepted_at, ${now}::timestamptz)
        where id = ${block.id}::uuid
      `
      await bumpPlan(tx, plan.id, true)
      return { ok: true }
    }
    case 'unpin': {
      if (block.state !== 'pinned') return invalid('This item is not pinned.')
      await tx`update public.plan_blocks set state = 'accepted' where id = ${block.id}::uuid`
      await bumpPlan(tx, plan.id, false)
      return { ok: true }
    }
    case 'dismiss': {
      if (block.state === 'dismissed' || block.state === 'done') {
        return invalid('Done or dismissed items cannot be dismissed.')
      }
      await tx`update public.plan_blocks set state = 'dismissed' where id = ${block.id}::uuid`
      await bumpPlan(tx, plan.id, false)
      return { ok: true }
    }
    case 'restore': {
      const checked = plannerValidateRestore(editContext(plan, blocks, now), block.id)
      if (!checked.ok) return checked
      await tx`
        update public.plan_blocks
        set state = case when accepted_at is null then 'suggested' else 'accepted' end
        where id = ${block.id}::uuid
      `
      await bumpPlan(tx, plan.id, false)
      return { ok: true }
    }
    case 'done': {
      if (block.state === 'dismissed' || block.state === 'done') {
        return invalid('Done or dismissed items cannot be marked done.')
      }
      await tx`
        update public.plan_blocks
        set state = 'done', done_at = ${now}::timestamptz,
            accepted_at = coalesce(accepted_at, ${now}::timestamptz)
        where id = ${block.id}::uuid
      `
      const othersOpen = blocks.some(
        (b) =>
          b.id !== block.id &&
          b.candidateKind === block.candidateKind &&
          b.candidateId === block.candidateId &&
          b.state !== 'done' &&
          b.state !== 'dismissed',
      )
      let message: string | undefined
      if (!othersOpen && TASK_KINDS.includes(block.candidateKind)) {
        const done = await tx`
          update public.tasks set status = 'done', completed_at = ${now}::timestamptz
          where id = ${block.candidateId}::uuid and status = 'open'
        `
        if (done.count > 0) message = 'Task completed.'
      } else if (!othersOpen && block.candidateKind === 'habit') {
        await tx`
          insert into public.habit_completions (habit_id, local_date, completed_at)
          select h.id, ${plan.localDate}::date, ${now}::timestamptz
          from public.habits h where h.id = ${block.candidateId}::uuid
          on conflict (habit_id, local_date) do nothing
        `
        message = 'Habit marked done for today.'
      }
      await bumpPlan(tx, plan.id, true)
      return { ok: true, message }
    }
  }
}

/**
 * Accept every current, confirmed suggestion. Tentative suggestions (unconfirmed inferences) and
 * suggestions whose time has passed are left for the owner to decide one by one.
 */
export async function plannerAcceptAll(
  tx: Tx,
  opts: { now: Date; localDate: string },
): Promise<{ accepted: number; skippedTentative: number }> {
  const plan = await lockPlan(tx, CalendarDateSchema.parse(opts.localDate))
  if (!plan) return { accepted: 0, skippedTentative: 0 }
  const rows = await tx`
    update public.plan_blocks
    set state = 'accepted', accepted_at = ${opts.now}::timestamptz
    where plan_id = ${plan.id}::uuid
      and state = 'suggested'
      and not tentative
      and (end_at is null or end_at > ${opts.now}::timestamptz)
  `
  const [skipped] = await tx<{ n: number }[]>`
    select count(*)::int as n from public.plan_blocks
    where plan_id = ${plan.id}::uuid and state = 'suggested' and tentative
  `
  if (rows.count > 0) await bumpPlan(tx, plan.id, true)
  return { accepted: rows.count, skippedTentative: skipped?.n ?? 0 }
}

/** Owner edit of a block's start time (local 'HH:MM' on the plan's date) and/or duration. */
export async function plannerEditBlock(
  tx: Tx,
  opts: { now: Date; blockId: string; startTime?: string | null; minutes: number },
): Promise<PlannerActionResult> {
  const plan = await lockPlanOfBlock(tx, opts.blockId)
  if (!plan) return { ok: false, code: 'not_found', message: 'That plan item no longer exists.' }
  const blocks = await blocksOf(tx, plan.id)
  const result = plannerValidateBlockEdit(editContext(plan, blocks, opts.now), opts.blockId, {
    startTime: opts.startTime ?? null,
    minutes: opts.minutes,
  })
  if (!result.ok) return result
  const before = blocks.find((b) => b.id === opts.blockId)!
  const u = result.value
  const durationChanged = u.minutes !== before.minutes
  await tx`
    update public.plan_blocks set
      start_at = ${u.start}::timestamptz,
      end_at = ${u.end}::timestamptz,
      minutes = ${u.minutes},
      estimated = case when ${durationChanged} then false else estimated end,
      edited_by_owner = true
    where id = ${u.id}::uuid
  `
  await bumpPlan(tx, plan.id, false)
  return { ok: true }
}

/** Move a block one place earlier ('up') or later ('down'). Both moved blocks count as edited. */
export async function plannerMoveBlock(
  tx: Tx,
  opts: { now: Date; blockId: string; direction: 'up' | 'down' },
): Promise<PlannerActionResult> {
  const plan = await lockPlanOfBlock(tx, opts.blockId)
  if (!plan) return { ok: false, code: 'not_found', message: 'That plan item no longer exists.' }
  const blocks = await blocksOf(tx, plan.id)
  const result = plannerValidateMove(
    editContext(plan, blocks, opts.now),
    opts.blockId,
    opts.direction,
  )
  if (!result.ok) return result
  for (const u of result.value) {
    await tx`
      update public.plan_blocks set
        start_at = ${u.start}::timestamptz,
        end_at = ${u.end}::timestamptz,
        position = ${u.position},
        edited_by_owner = true
      where id = ${u.id}::uuid
    `
  }
  await bumpPlan(tx, plan.id, false)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Week overview
// ---------------------------------------------------------------------------

export interface PlannerWeekDay {
  localDate: string
  tasksDue: number
  /** Accepted, pinned or done blocks in that day's plan. */
  acceptedBlocks: number
  hasPlan: boolean
  /** Busy calendar events: unknown until calendars are connected (never a fabricated zero). */
  busyEvents: number | null
}

export async function plannerWeekSummary(
  tx: Tx,
  opts: { from: string; days?: number },
): Promise<PlannerWeekDay[]> {
  const from = CalendarDateSchema.parse(opts.from)
  const days = Math.max(1, Math.min(14, opts.days ?? 7))
  const to = addLocalDays(from, days - 1)
  const tasks = await tx<{ localDate: string; n: number }[]>`
    select due_date as local_date, count(*)::int as n
    from public.tasks
    where status = 'open' and due_date between ${from}::date and ${to}::date
    group by due_date
  `
  const plans = await tx<{ localDate: string; n: number }[]>`
    select p.local_date, count(b.id) filter (where b.state in ('accepted', 'pinned', 'done'))::int as n
    from public.daily_plans p
    left join public.plan_blocks b on b.plan_id = p.id
    where p.local_date between ${from}::date and ${to}::date
    group by p.local_date
  `
  const taskMap = new Map(tasks.map((r) => [r.localDate, r.n]))
  const planMap = new Map(plans.map((r) => [r.localDate, r.n]))
  const out: PlannerWeekDay[] = []
  for (let i = 0; i < days; i++) {
    const localDate = addLocalDays(from, i)
    out.push({
      localDate,
      tasksDue: taskMap.get(localDate) ?? 0,
      acceptedBlocks: planMap.get(localDate) ?? 0,
      hasPlan: planMap.has(localDate),
      busyEvents: null,
    })
  }
  return out
}

/** Titles and statuses of the tasks behind plan blocks (for "task completed elsewhere" hints). */
export async function plannerTaskStatuses(
  tx: Tx,
  taskIds: readonly string[],
): Promise<Map<string, 'open' | 'done' | 'cancelled'>> {
  if (taskIds.length === 0) return new Map()
  const rows = await tx<{ id: string; status: 'open' | 'done' | 'cancelled' }[]>`
    select id, status from public.tasks where id = any (${[...taskIds]}::uuid[])
  `
  return new Map(rows.map((r) => [r.id, r.status]))
}
