/**
 * Deterministic validation of owner edits to a plan (edit time/duration, move earlier/later),
 * and small display helpers shared by the web views.
 */
import { addLocalDays, zonedLocalToUtc } from '../time/index.ts'
import { plannerTimeLabel } from './format.ts'
import { MINUTE_MS, plannerAlignDown, plannerSpansOverlap, type PlannerSpan } from './intervals.ts'
import { plannerEventBlocksTime } from './plan-day.ts'
import { plannerCandidateKey } from './rank.ts'
import type { PlanCurrentBlock } from './revise.ts'
import type { PlannerBusyEventInput } from './schemas.ts'

export interface PlannerEditContext {
  timezone: string
  /** The plan's local date. */
  localDate: string
  now: Date
  /** Every block of the plan (any state). */
  blocks: readonly PlanCurrentBlock[]
  /** Busy calendar events for the day (empty until calendars are connected). */
  busy?: readonly PlannerBusyEventInput[]
  granularityMinutes?: number
}

export type PlannerEditErrorCode =
  | 'not_found'
  | 'not_editable'
  | 'invalid_range'
  | 'outside_day'
  | 'in_past'
  | 'overlaps_block'
  | 'overlaps_event'
  | 'no_neighbour'
  | 'mixed_modes'

export type PlannerEditResult<T> =
  { ok: true; value: T } | { ok: false; code: PlannerEditErrorCode; message: string }

export interface PlannerBlockTimeUpdate {
  id: string
  start: string | null
  end: string | null
  minutes: number
  position: number
}

function fail<T>(code: PlannerEditErrorCode, message: string): PlannerEditResult<T> {
  return { ok: false, code, message }
}

function spanOf(b: { start: string | null; end: string | null }): PlannerSpan | null {
  return b.start && b.end ? { start: Date.parse(b.start), end: Date.parse(b.end) } : null
}

function dayBounds(localDate: string, tz: string): PlannerSpan {
  return {
    start: zonedLocalToUtc(localDate, '00:00', tz).getTime(),
    end: zonedLocalToUtc(addLocalDays(localDate, 1), '00:00', tz).getTime(),
  }
}

/** Blocks that still occupy time on the plan (anything not dismissed). */
function occupying(b: PlanCurrentBlock): boolean {
  return b.state !== 'dismissed'
}

/**
 * Check a proposed time range for one or more blocks. `ignore` lists blocks whose current
 * position must not count (the blocks being changed).
 */
function validateSpan(
  ctx: PlannerEditContext,
  span: PlannerSpan,
  ignore: ReadonlySet<string>,
  startChanged: boolean,
): PlannerEditResult<null> {
  const tz = ctx.timezone
  if (!(span.end > span.start)) return fail('invalid_range', 'The end must be after the start.')
  const day = dayBounds(ctx.localDate, tz)
  if (span.start < day.start || span.end > day.end) {
    return fail('outside_day', 'Keep the block within this day.')
  }
  const g = (ctx.granularityMinutes ?? 5) * MINUTE_MS
  if (startChanged && span.start < plannerAlignDown(ctx.now.getTime(), g)) {
    return fail('in_past', 'That time has already passed. Choose a later start.')
  }
  const range = (s: PlannerSpan) =>
    `${plannerTimeLabel(s.start, tz)}–${plannerTimeLabel(s.end, tz)}`
  for (const other of ctx.blocks) {
    if (ignore.has(other.id) || !occupying(other)) continue
    const os = spanOf(other)
    if (os && plannerSpansOverlap(os, span)) {
      return fail(
        'overlaps_block',
        `Overlaps “${other.title}” (${range(os)}). Move or dismiss it first.`,
      )
    }
  }
  for (const e of ctx.busy ?? []) {
    if (!plannerEventBlocksTime({ allDay: e.allDay ?? false, busy: e.busy ?? null })) continue
    const es = { start: new Date(e.start).getTime(), end: new Date(e.end).getTime() }
    if (plannerSpansOverlap(es, span)) {
      return fail(
        'overlaps_event',
        `Overlaps ${e.title ? `“${e.title}”` : 'a busy calendar event'} (${range(es)}).`,
      )
    }
  }
  return { ok: true, value: null }
}

/**
 * Owner edit of one block's start time and/or duration. `startTime` is a local 'HH:MM' on the
 * plan's date (DST gaps resolve forward, like every other local time in the app). List-mode
 * items (no times) only take a duration.
 */
export function plannerValidateBlockEdit(
  ctx: PlannerEditContext,
  blockId: string,
  change: { startTime?: string | null; minutes: number },
): PlannerEditResult<PlannerBlockTimeUpdate> {
  const block = ctx.blocks.find((b) => b.id === blockId)
  if (!block) return fail('not_found', 'That plan item no longer exists.')
  if (block.state === 'dismissed' || block.state === 'done') {
    return fail('not_editable', 'Dismissed or done items cannot be edited.')
  }
  if (!Number.isInteger(change.minutes) || change.minutes < 5 || change.minutes > 720) {
    return fail('invalid_range', 'Duration must be between 5 minutes and 12 hours.')
  }
  const current = spanOf(block)
  if (!current) {
    if (change.startTime) {
      return fail('mixed_modes', 'This plan has no times yet. Set available hours to plan by time.')
    }
    return {
      ok: true,
      value: {
        id: block.id,
        start: null,
        end: null,
        minutes: change.minutes,
        position: block.position,
      },
    }
  }
  const start = change.startTime
    ? zonedLocalToUtc(ctx.localDate, change.startTime, ctx.timezone).getTime()
    : current.start
  const span = { start, end: start + change.minutes * MINUTE_MS }
  const checked = validateSpan(ctx, span, new Set([block.id]), start !== current.start)
  if (!checked.ok) return checked
  return {
    ok: true,
    value: {
      id: block.id,
      start: new Date(span.start).toISOString(),
      end: new Date(span.end).toISOString(),
      minutes: change.minutes,
      position: block.position,
    },
  }
}

/**
 * Undo a dismissal. A timed block can come back only if its slot is still free (the owner or
 * a replan may have used it since); list items can always come back.
 */
export function plannerValidateRestore(
  ctx: PlannerEditContext,
  blockId: string,
): PlannerEditResult<null> {
  const block = ctx.blocks.find((b) => b.id === blockId)
  if (!block) return fail('not_found', 'That plan item no longer exists.')
  if (block.state !== 'dismissed') return fail('not_editable', 'Only dismissed items can be restored.')
  const span = spanOf(block)
  if (!span) return { ok: true, value: null }
  const checked = validateSpan(ctx, span, new Set([block.id]), false)
  if (!checked.ok && (checked.code === 'overlaps_block' || checked.code === 'overlaps_event')) {
    return fail(checked.code, `Its time is taken now. ${checked.message} Or replan the day.`)
  }
  return checked
}

/**
 * Move a block one place earlier or later. Timed blocks swap slots with their neighbour
 * (the pair keeps its overall span and the gap between them); list items swap positions.
 * Done and dismissed items are skipped as neighbours.
 */
export function plannerValidateMove(
  ctx: PlannerEditContext,
  blockId: string,
  direction: 'up' | 'down',
): PlannerEditResult<PlannerBlockTimeUpdate[]> {
  const block = ctx.blocks.find((b) => b.id === blockId)
  if (!block) return fail('not_found', 'That plan item no longer exists.')
  if (block.state === 'dismissed' || block.state === 'done') {
    return fail('not_editable', 'Dismissed or done items cannot be moved.')
  }
  const timed = spanOf(block) !== null
  const movable = ctx.blocks.filter(
    (b) => b.state !== 'dismissed' && b.state !== 'done' && (spanOf(b) !== null) === timed,
  )
  const ordered = [...movable].sort((a, b) =>
    timed
      ? Date.parse(a.start!) - Date.parse(b.start!) ||
        a.position - b.position ||
        (a.id < b.id ? -1 : 1)
      : a.position - b.position || (a.id < b.id ? -1 : 1),
  )
  const i = ordered.findIndex((b) => b.id === blockId)
  const j = direction === 'up' ? i - 1 : i + 1
  const neighbour = ordered[j]
  if (!neighbour) {
    return fail('no_neighbour', direction === 'up' ? 'Already first.' : 'Already last.')
  }
  if (!timed) {
    let a = block.position
    let b = neighbour.position
    if (a === b) {
      // Defensive: equal positions cannot be swapped meaningfully; order by the sort instead.
      a = j
      b = i
    }
    return {
      ok: true,
      value: [
        { id: block.id, start: null, end: null, minutes: block.minutes, position: b },
        { id: neighbour.id, start: null, end: null, minutes: neighbour.minutes, position: a },
      ],
    }
  }
  const [first, second] = direction === 'up' ? [neighbour, block] : [block, neighbour]
  const fs = spanOf(first)!
  const ss = spanOf(second)!
  const gap = Math.max(0, ss.start - fs.end)
  const newSecond = { start: fs.start, end: fs.start + (ss.end - ss.start) }
  const newFirst = { start: newSecond.end + gap, end: newSecond.end + gap + (fs.end - fs.start) }
  const ignore = new Set([first.id, second.id])
  for (const span of [newSecond, newFirst]) {
    const checked = validateSpan(ctx, span, ignore, true)
    if (!checked.ok) return checked
  }
  const iso = (ms: number) => new Date(ms).toISOString()
  return {
    ok: true,
    value: [
      {
        id: second.id,
        start: iso(newSecond.start),
        end: iso(newSecond.end),
        minutes: second.minutes,
        position: first.position,
      },
      {
        id: first.id,
        start: iso(newFirst.start),
        end: iso(newFirst.end),
        minutes: first.minutes,
        position: second.position,
      },
    ],
  }
}

/**
 * "1 of 2" labels for candidates that occupy more than one active block, numbered in time
 * (or list) order across every non-dismissed block of that candidate.
 */
export function plannerSplitLabels(
  blocks: readonly PlanCurrentBlock[],
): Map<string, { part: number; total: number }> {
  const groups = new Map<string, PlanCurrentBlock[]>()
  for (const b of blocks) {
    if (b.state === 'dismissed') continue
    const k = plannerCandidateKey(b.candidateKind, b.candidateId)
    groups.set(k, [...(groups.get(k) ?? []), b])
  }
  const out = new Map<string, { part: number; total: number }>()
  for (const list of groups.values()) {
    if (list.length < 2) continue
    list.sort(
      (a, b) =>
        (a.start && b.start ? Date.parse(a.start) - Date.parse(b.start) : 0) ||
        a.position - b.position ||
        (a.id < b.id ? -1 : 1),
    )
    list.forEach((b, i) => out.set(b.id, { part: i + 1, total: list.length }))
  }
  return out
}

/**
 * The next thing to do: the current or next timed block (not done or dismissed), or the first
 * open list item. Suggestions whose slot has passed are skipped.
 */
export function plannerNextAction<T extends PlanCurrentBlock>(
  blocks: readonly T[],
  now: Date,
): T | null {
  const nowMs = now.getTime()
  const active = blocks.filter((b) => b.state !== 'done' && b.state !== 'dismissed')
  const timed = active
    .filter((b) => b.start && b.end && Date.parse(b.end) > nowMs)
    .sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!) || a.position - b.position)
  if (timed[0]) return timed[0]
  const listed = active
    .filter((b) => !b.start)
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))
  return listed[0] ?? null
}
