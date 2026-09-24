/**
 * Server-side loaders for the Home modules. Every read runs in its own owner transaction
 * (withOwnerTx → requireOwner, RLS enforced), one per source, so a failing source is reported
 * as unavailable without blanking the others (a failed query aborts its whole transaction).
 *
 * Nothing here calls a provider or the AI gateway: Home shows saved data only.
 */
import 'server-only'
import { unstable_rethrow } from 'next/navigation'
import { isValidTimeZone, localDateInZone } from '@personal-home/core'
import {
  demoDataPresent,
  getLatestPublishedBriefing,
  listHabitCompletions,
  listHabits,
  listNeedsAttention,
  listPeopleAttention,
  listRecentBriefings,
  listTasks,
  type OwnerSettings,
  type Tx,
} from '@personal-home/db'
import { withOwnerTx } from '@/lib/server/session'
import {
  buildHomeAttention,
  buildHomeBriefing,
  buildHomeToday,
  type HomeAttentionView,
  type HomeBriefingView,
  type HomeSourceResult,
  type HomeTodayView,
} from './view'

/** Items shown in Needs attention before "N more". */
export const HOME_ATTENTION_LIMIT = 6
/** Tasks shown in Today before "N more". */
export const HOME_TODAY_TASK_LIMIT = 6
/** Important dates are checked this far ahead (each date's own reminder window decides). */
export const HOME_PEOPLE_HORIZON_DAYS = 60

/** The owner's timezone when this runtime can use it; null otherwise (modules say so). */
export function homeTimeZone(settings: OwnerSettings): string | null {
  return isValidTimeZone(settings.timezone) ? settings.timezone : null
}

/** Run one source's read; a failure is logged by kind only and reported as unavailable. */
async function source<T>(kind: string, fn: (tx: Tx) => Promise<T>): Promise<HomeSourceResult<T>> {
  try {
    return { ok: true, data: await withOwnerTx(fn) }
  } catch (error) {
    unstable_rethrow(error) // redirects from requireOwner()
    const code = (error as { code?: unknown })?.code
    console.error(`[home] could not load ${kind}`, {
      name: error instanceof Error ? error.name : typeof error,
      code: typeof code === 'string' ? code : undefined,
    })
    return { ok: false }
  }
}

export async function loadHomeAttention(now: Date, tz: string): Promise<HomeAttentionView> {
  const today = localDateInZone(now, tz)
  const [tasks, people] = await Promise.all([
    source('tasks attention', (tx) =>
      listNeedsAttention(tx, now, tz, { limit: HOME_ATTENTION_LIMIT }),
    ),
    source('people attention', (tx) => listPeopleAttention(tx, today, HOME_PEOPLE_HORIZON_DAYS)),
  ])
  return buildHomeAttention({ tasks, people, now, tz, limit: HOME_ATTENTION_LIMIT })
}

export async function loadHomeToday(now: Date, tz: string): Promise<HomeTodayView> {
  const today = localDateInZone(now, tz)
  const [tasks, habits] = await Promise.all([
    source('today tasks', async (tx) => ({
      open: await listTasks(tx, {
        filter: 'today',
        now,
        tz,
        limit: 500,
      }),
      done: await listTasks(tx, { filter: 'done', limit: 20 }),
    })),
    source('today habits', async (tx) => {
      const list = await listHabits(tx)
      const completions = await listHabitCompletions(tx, { from: today, to: today })
      return { habits: list, doneToday: new Set(completions.map((c) => c.habitId)) }
    }),
  ])
  return buildHomeToday({
    now,
    tz,
    limit: HOME_TODAY_TASK_LIMIT,
    openToday: tasks.ok ? { ok: true, data: tasks.data.open } : { ok: false },
    recentlyDone: tasks.ok ? { ok: true, data: tasks.data.done } : { ok: false },
    habits,
  })
}

export async function loadHomeBriefing(
  now: Date,
  tz: string,
  timezoneConfirmed: boolean,
): Promise<HomeSourceResult<HomeBriefingView>> {
  const rows = await source('briefing', async (tx) => ({
    latestPublished: await getLatestPublishedBriefing(tx),
    // Newest by scheduled time (the list is ordered by date and kind name).
    mostRecent:
      (await listRecentBriefings(tx, 4)).sort(
        (a, b) => b.scheduledFor.getTime() - a.scheduledFor.getTime(),
      )[0] ?? null,
  }))
  if (!rows.ok) return rows
  return {
    ok: true,
    data: buildHomeBriefing({ ...rows.data, now, tz, timezoneConfirmed }),
  }
}

/** Whether labelled demo rows are present (Home says so plainly). Unknown on failure. */
export async function loadDemoPresence(): Promise<boolean | null> {
  const r = await source('demo presence', (tx) => demoDataPresent(tx))
  return r.ok ? r.data : null
}
