/**
 * Where plan candidates come from. Each source reads one kind of owner data; later milestones
 * add sources (email deadlines, project actions from captured chats) without touching the planner.
 */
import { isoWeekday, type PlannerCandidateInput } from '@personal-home/core'
import type { Tx } from '../client.ts'

export interface PlannerCandidateSourceContext {
  /** The planned local date. */
  localDate: string
  timezone: string
  now: Date
}

export interface PlannerCandidateSource {
  /** Short owner-facing name, used when a source fails ("habits could not be read"). */
  readonly name: string
  load(tx: Tx, ctx: PlannerCandidateSourceContext): Promise<PlannerCandidateInput[]>
}

const MAX_TASKS = 500

interface TaskCandidateRow {
  id: string
  title: string
  dueAt: Date | null
  dueDate: string | null
  priority: number | null
  durationMinutes: number | null
  splittable: boolean
  confirmed: boolean
  source: string
  createdAt: Date
  projectId: string | null
}

/**
 * Open tasks from public.tasks. Accepted project actions and email deadlines are tasks with
 * source 'project_action' / 'email_suggestion'; `confirmed = false` makes them tentative.
 */
export const plannerTaskSource: PlannerCandidateSource = {
  name: 'tasks',
  async load(tx) {
    const rows = await tx<TaskCandidateRow[]>`
      select id, title, due_at, due_date, priority, duration_minutes, splittable, confirmed,
             source, created_at, project_id
      from public.tasks
      where status = 'open'
      order by created_at, id
      limit ${MAX_TASKS}
    `
    return rows.map((r) => ({
      id: r.id,
      kind:
        r.source === 'project_action'
          ? 'project_action'
          : r.source === 'email_suggestion'
            ? 'email_deadline'
            : 'task',
      title: r.title,
      dueAt: r.dueAt,
      dueDate: r.dueDate,
      priority: r.priority,
      durationMinutes: r.durationMinutes,
      splittable: r.splittable,
      confirmed: r.confirmed,
      createdAt: r.createdAt,
      projectId: r.projectId,
    }))
  },
}

/** Active habits due on the planned date's ISO weekday that are not yet completed that day. */
export const plannerHabitSource: PlannerCandidateSource = {
  name: 'habits',
  async load(tx, ctx) {
    const weekday = isoWeekday(ctx.localDate)
    const rows = await tx<{ id: string; title: string; createdAt: Date }[]>`
      select h.id, h.title, h.created_at
      from public.habits h
      where h.active
        and h.archived_at is null
        and ${weekday}::smallint = any (h.weekdays)
        and not exists (
          select 1 from public.habit_completions c
          where c.habit_id = h.id and c.local_date = ${ctx.localDate}::date
        )
      order by h.created_at, h.id
    `
    return rows.map((r) => ({
      id: r.id,
      kind: 'habit' as const,
      title: r.title,
      createdAt: r.createdAt,
      splittable: false,
      confirmed: true,
    }))
  },
}

/**
 * Active reading goals: learning goals tied to a book that is not finished, not already
 * covered by a practice habit, and with no reading logged for that book on the planned date.
 */
export const plannerReadingGoalSource: PlannerCandidateSource = {
  name: 'reading goals',
  async load(tx, ctx) {
    const rows = await tx<
      { id: string; title: string; targetDate: string | null; createdAt: Date }[]
    >`
      select g.id, g.title, g.target_date, g.created_at
      from public.learning_goals g
      join public.books b on b.id = g.book_id
      where g.status = 'active'
        and g.habit_id is null
        and b.status <> 'finished'
        and not exists (
          select 1 from public.reading_logs l
          where l.book_id = g.book_id and l.local_date = ${ctx.localDate}::date
        )
      order by g.created_at, g.id
    `
    return rows.map((r) => ({
      id: r.id,
      kind: 'reading_goal' as const,
      title: r.title,
      dueDate: r.targetDate,
      createdAt: r.createdAt,
      splittable: false,
      confirmed: true,
    }))
  },
}

export const PLANNER_DEFAULT_SOURCES: readonly PlannerCandidateSource[] = [
  plannerTaskSource,
  plannerHabitSource,
  plannerReadingGoalSource,
]

export interface PlannerCandidateLoad {
  candidates: PlannerCandidateInput[]
  /** Names of sources that failed; their candidates are missing from the plan. */
  failedSources: string[]
}

/**
 * Load candidates from every source. Each source runs in its own savepoint, so one failing
 * source is reported (never silently treated as "nothing to do") and the others still load.
 */
export async function plannerLoadCandidates(
  tx: Tx,
  ctx: PlannerCandidateSourceContext,
  sources: readonly PlannerCandidateSource[] = PLANNER_DEFAULT_SOURCES,
): Promise<PlannerCandidateLoad> {
  const candidates: PlannerCandidateInput[] = []
  const failedSources: string[] = []
  for (const source of sources) {
    try {
      const loaded = await tx.savepoint((sp) => source.load(sp, ctx))
      candidates.push(...loaded)
    } catch {
      failedSources.push(source.name)
    }
  }
  return { candidates, failedSources }
}
