'use server'
/**
 * Server actions for the Plan pages. Each one authenticates (withOwnerTx → requireOwner),
 * validates its form input with zod, runs in one owner transaction (RLS applies), and only
 * ever touches local plan data: nothing is written to an external calendar.
 */
import { addLocalDays, localDateInZone } from '@personal-home/core'
import {
  plannerAcceptAll,
  plannerApplyBlockAction,
  plannerEditBlock,
  plannerLoadSettings,
  plannerMoveBlock,
  plannerReplan,
  type PlannerActionResult,
} from '@personal-home/db'
import { revalidatePath } from 'next/cache'
import { unstable_rethrow } from 'next/navigation'
import { withOwnerTx } from '@/lib/server/session'
import { PlanBlockFormSchema, PlanDayFormSchema, parsePlanForm } from './inputs'

export interface PlanActionState {
  ok: boolean
  message: string | null
  intent: string | null
  /** Changes on every submission so effects can react to repeated identical results. */
  seq: number
}

let counter = 0
const state = (ok: boolean, message: string | null, intent: string | null): PlanActionState => ({
  ok,
  message,
  intent,
  seq: Date.now() * 1000 + (++counter % 1000),
})

function refreshViews() {
  revalidatePath('/plan', 'layout')
  revalidatePath('/')
}

const SAVE_FAILED = "Couldn't save that change. Please try again."

export async function planBlockAction(
  _prev: PlanActionState | null,
  formData: FormData,
): Promise<PlanActionState> {
  const parsed = parsePlanForm(PlanBlockFormSchema, formData)
  if (!parsed.ok) return state(false, parsed.message, null)
  const { blockId, intent, startTime, minutes } = parsed.data
  const now = new Date()
  let result: PlannerActionResult
  try {
    result = await withOwnerTx((tx) => {
      switch (intent) {
        case 'edit':
          return plannerEditBlock(tx, { now, blockId, startTime, minutes: minutes! })
        case 'up':
        case 'down':
          return plannerMoveBlock(tx, { now, blockId, direction: intent })
        default:
          return plannerApplyBlockAction(tx, { now, blockId, action: intent })
      }
    })
  } catch (error) {
    unstable_rethrow(error)
    return state(false, SAVE_FAILED, intent)
  }
  if (result.ok) refreshViews()
  return state(result.ok, result.ok ? (result.message ?? null) : result.message, intent)
}

/** Resolve the owner's today and check the date can be planned (today or tomorrow). */
async function plannableDate(localDate: string, now: Date) {
  return withOwnerTx(async (tx) => {
    const { timezone } = await plannerLoadSettings(tx)
    const today = localDateInZone(now, timezone)
    return localDate === today || localDate === addLocalDays(today, 1)
  })
}

export async function replanDayAction(
  _prev: PlanActionState | null,
  formData: FormData,
): Promise<PlanActionState> {
  const parsed = parsePlanForm(PlanDayFormSchema, formData)
  if (!parsed.ok) return state(false, parsed.message, 'replan')
  const now = new Date()
  try {
    if (!(await plannableDate(parsed.data.localDate, now))) {
      return state(false, 'Plans can be drafted for today and tomorrow only.', 'replan')
    }
    const { revision, created } = await withOwnerTx((tx) =>
      plannerReplan(tx, { now, localDate: parsed.data.localDate }),
    )
    refreshViews()
    if (created || !revision) return state(true, 'Plan drafted.', 'replan')
    const parts = [
      revision.additions.length ? `${revision.additions.length} added` : null,
      revision.moves.length ? `${revision.moves.length} moved` : null,
      revision.removals.length ? `${revision.removals.length} removed` : null,
    ].filter(Boolean)
    const summary = parts.length
      ? `Replanned: ${parts.join(', ')}.`
      : 'Replanned: no changes needed.'
    const kept = revision.kept.filter((b) => b.state !== 'dismissed').length
    return state(
      true,
      kept > 0
        ? `${summary} Your accepted, pinned and edited items were kept as they are.`
        : summary,
      'replan',
    )
  } catch (error) {
    unstable_rethrow(error)
    return state(false, "Couldn't replan right now. Your plan is unchanged.", 'replan')
  }
}

export async function acceptAllAction(
  _prev: PlanActionState | null,
  formData: FormData,
): Promise<PlanActionState> {
  const parsed = parsePlanForm(PlanDayFormSchema, formData)
  if (!parsed.ok) return state(false, parsed.message, 'accept_all')
  const now = new Date()
  try {
    if (!(await plannableDate(parsed.data.localDate, now))) {
      return state(false, 'Only today and tomorrow can be changed.', 'accept_all')
    }
    const r = await withOwnerTx((tx) =>
      plannerAcceptAll(tx, { now, localDate: parsed.data.localDate }),
    )
    refreshViews()
    const accepted =
      r.accepted === 0
        ? 'Nothing to accept.'
        : `Accepted ${r.accepted} suggestion${r.accepted === 1 ? '' : 's'}.`
    const tentative =
      r.skippedTentative > 0
        ? ` ${r.skippedTentative} tentative suggestion${r.skippedTentative === 1 ? ' is' : 's are'} left for you to decide.`
        : ''
    return state(true, accepted + tentative, 'accept_all')
  } catch (error) {
    unstable_rethrow(error)
    return state(false, SAVE_FAILED, 'accept_all')
  }
}
