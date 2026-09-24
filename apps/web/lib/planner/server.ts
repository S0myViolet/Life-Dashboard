/**
 * Server-side loaders for the planner views. Every read runs in an owner transaction
 * (withOwnerTx → requireOwner + RLS). Today's plan is drafted on first use each local day.
 */
import 'server-only'
import { CalendarDateSchema, addLocalDays, localDateInZone } from '@personal-home/core'
import {
  plannerEnsureTodayPlan,
  plannerGetPlan,
  plannerLoadSettings,
  plannerPreviewRevision,
  plannerTaskStatuses,
  plannerWeekSummary,
  type PlannerPlan,
  type Tx,
} from '@personal-home/db'
import { withOwnerTx } from '@/lib/server/session'
import {
  buildPlanDayView,
  buildPlanWeekView,
  planWeekStart,
  type PlanDayView,
  type PlanWeekDayView,
} from './view'

const TASK_KINDS = new Set(['task', 'project_action', 'email_deadline'])

async function sourceStatuses(tx: Tx, plan: PlannerPlan | null) {
  if (!plan) return new Map<string, 'open' | 'done' | 'cancelled'>()
  const ids = [
    ...new Set(
      plan.blocks.filter((b) => TASK_KINDS.has(b.candidateKind)).map((b) => b.candidateId),
    ),
  ]
  return plannerTaskStatuses(tx, ids)
}

/**
 * The Day view. Without a date (or for today) the plan is drafted on first use; other days are
 * only read (tomorrow can be drafted with "Plan this day").
 */
export async function loadPlanDay(localDate?: string): Promise<PlanDayView> {
  const now = new Date()
  return withOwnerTx(async (tx) => {
    const settings = await plannerLoadSettings(tx)
    const today = localDateInZone(now, settings.timezone)
    const date = localDate ? CalendarDateSchema.parse(localDate) : today
    let plan: PlannerPlan | null
    let justCreated = false
    if (date === today) {
      const ensured = await plannerEnsureTodayPlan(tx, { now })
      plan = ensured.plan
      justCreated = ensured.created
    } else {
      plan = await plannerGetPlan(tx, date)
    }
    // What a replan would change (new tasks, completed ones...). Shown as a proposal only.
    const revision =
      plan && !justCreated && date >= today
        ? await plannerPreviewRevision(tx, { now, localDate: date })
        : null
    return buildPlanDayView({
      localDate: date,
      today,
      timezone: settings.timezone,
      now,
      plan,
      revision,
      sourceStatuses: await sourceStatuses(tx, plan),
    })
  })
}

export interface TodaysPlanCardData {
  view: PlanDayView
}

/** Home card: today's plan (drafted on first use), priorities and the next suggested action. */
export async function loadTodaysPlanCard(): Promise<TodaysPlanCardData> {
  const now = new Date()
  return withOwnerTx(async (tx) => {
    const { plan, today } = await plannerEnsureTodayPlan(tx, { now })
    const settings = await plannerLoadSettings(tx)
    return {
      view: buildPlanDayView({
        localDate: today,
        today,
        timezone: settings.timezone,
        now,
        plan,
        sourceStatuses: await sourceStatuses(tx, plan),
      }),
    }
  })
}

export interface PlanWeekData {
  start: string
  prevStart: string
  nextStart: string
  today: string
  days: PlanWeekDayView[]
}

export async function loadPlanWeek(start?: string): Promise<PlanWeekData> {
  const now = new Date()
  return withOwnerTx(async (tx) => {
    const settings = await plannerLoadSettings(tx)
    const today = localDateInZone(now, settings.timezone)
    const parsed = start ? CalendarDateSchema.safeParse(start) : null
    const monday = planWeekStart(parsed?.success ? parsed.data : today)
    const days = await plannerWeekSummary(tx, { from: monday, days: 7 })
    return {
      start: monday,
      prevStart: addLocalDays(monday, -7),
      nextStart: addLocalDays(monday, 7),
      today,
      days: buildPlanWeekView({ days, today }),
    }
  })
}
