/**
 * Learning goals repository (public.learning_goals), plus the small slice of
 * public.habits a goal needs: listing habits to link, and creating a practice habit
 * from the goal form. Habit completion and history belong to the habits UI.
 */
import {
  CalendarDateSchema,
  isoWeekday,
  LearningGoalInputSchema,
  LearningGoalStatusSchema,
  learningGoalSummary,
  PracticeHabitInputSchema,
  readingProgress,
  type BookStatus,
  type LearningGoalInput,
  type LearningGoalStatus,
  type LearningGoalSummary,
  type PracticeHabitInput,
  type ReadingProgress,
} from '@personal-home/core'
import type { Tx } from '../client.ts'
import { listReadingLogsForBooks, readingMinutesOn, type LearningResult } from './books.ts'

export interface LearningGoal {
  id: string
  title: string
  details: string | null
  targetDate: string | null
  status: LearningGoalStatus
  habitId: string | null
  bookId: string | null
  dailyMinutes: number | null
  createdAt: Date
  updatedAt: Date
}

export interface LearningGoalHabit {
  id: string
  title: string
  weekdays: number[]
  active: boolean
  archived: boolean
  dueToday: boolean
  doneToday: boolean
}

export interface LearningGoalView extends LearningGoal {
  habit: LearningGoalHabit | null
  book: { id: string; title: string; status: BookStatus; progress: ReadingProgress } | null
  summary: LearningGoalSummary
}

export interface PracticeHabitOption {
  id: string
  title: string
  weekdays: number[]
  active: boolean
}

const goalColumns = (tx: Tx) =>
  tx`id, title, details, target_date, status, habit_id, book_id, daily_minutes, created_at, updated_at`

async function checkReferences(
  tx: Tx,
  fields: { habitId: string | null; bookId: string | null },
): Promise<LearningResult<never> | null> {
  if (fields.habitId) {
    const rows = await tx`select 1 from public.habits where id = ${fields.habitId}::uuid`
    if (rows.length === 0) {
      return {
        ok: false,
        reason: 'invalid',
        field: 'habitId',
        message: 'That habit no longer exists',
      }
    }
  }
  if (fields.bookId) {
    const rows = await tx`select 1 from public.books where id = ${fields.bookId}::uuid`
    if (rows.length === 0) {
      return {
        ok: false,
        reason: 'invalid',
        field: 'bookId',
        message: 'That book no longer exists',
      }
    }
  }
  return null
}

export async function createLearningGoal(
  tx: Tx,
  input: LearningGoalInput,
): Promise<LearningResult<LearningGoal>> {
  const f = LearningGoalInputSchema.parse(input)
  const problem = await checkReferences(tx, f)
  if (problem) return problem
  const [row] = await tx<LearningGoal[]>`
    insert into public.learning_goals (title, details, target_date, status, habit_id, book_id, daily_minutes)
    values (${f.title}, ${f.details}, ${f.targetDate}, ${f.status}, ${f.habitId}, ${f.bookId}, ${f.dailyMinutes})
    returning ${goalColumns(tx)}
  `
  if (!row) throw new Error('insert into learning_goals returned no row')
  return { ok: true, value: row }
}

export async function updateLearningGoal(
  tx: Tx,
  id: string,
  input: LearningGoalInput,
): Promise<LearningResult<LearningGoal>> {
  const f = LearningGoalInputSchema.parse(input)
  const problem = await checkReferences(tx, f)
  if (problem) return problem
  const [row] = await tx<LearningGoal[]>`
    update public.learning_goals
    set title = ${f.title}, details = ${f.details}, target_date = ${f.targetDate}, status = ${f.status},
        habit_id = ${f.habitId}, book_id = ${f.bookId}, daily_minutes = ${f.dailyMinutes}
    where id = ${id}::uuid
    returning ${goalColumns(tx)}
  `
  return row ? { ok: true, value: row } : { ok: false, reason: 'not_found' }
}

export async function setLearningGoalStatus(
  tx: Tx,
  id: string,
  status: LearningGoalStatus,
): Promise<LearningGoal | null> {
  const next = LearningGoalStatusSchema.parse(status)
  const [row] = await tx<LearningGoal[]>`
    update public.learning_goals set status = ${next} where id = ${id}::uuid
    returning ${goalColumns(tx)}
  `
  return row ?? null
}

export async function deleteLearningGoal(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx`delete from public.learning_goals where id = ${id}::uuid returning id`
  return rows.length > 0
}

export async function getLearningGoal(tx: Tx, id: string): Promise<LearningGoal | null> {
  const [row] = await tx<LearningGoal[]>`
    select ${goalColumns(tx)} from public.learning_goals where id = ${id}::uuid
  `
  return row ?? null
}

/**
 * Goals with their linked habit (due/done today), linked book progress and summary.
 * Active goals first (soonest target first), then paused, then done.
 */
export async function listLearningGoals(
  tx: Tx,
  today: string,
  options: { includeDone?: boolean } = {},
): Promise<LearningGoalView[]> {
  const day = CalendarDateSchema.parse(today)
  const goals = await tx<LearningGoal[]>`
    select ${goalColumns(tx)} from public.learning_goals
    where ${options.includeDone === false ? tx`status <> 'done'` : tx`true`}
    order by array_position(array['active', 'paused', 'done']::text[], status),
             target_date nulls last, created_at desc, id
  `
  if (goals.length === 0) return []

  const habitIds = [...new Set(goals.flatMap((g) => (g.habitId ? [g.habitId] : [])))]
  const habits = habitIds.length
    ? await tx<
        {
          id: string
          title: string
          weekdays: number[]
          active: boolean
          archived: boolean
          doneToday: boolean
        }[]
      >`
        select h.id, h.title, h.weekdays::int[] as weekdays, h.active, h.archived_at is not null as archived,
               exists (select 1 from public.habit_completions c
                       where c.habit_id = h.id and c.local_date = ${day}) as done_today
        from public.habits h
        where h.id = any(${habitIds}::uuid[])
      `
    : []
  const habitById = new Map(habits.map((h) => [h.id, h]))
  const weekday = isoWeekday(day)

  const bookIds = [...new Set(goals.flatMap((g) => (g.bookId ? [g.bookId] : [])))]
  const books = bookIds.length
    ? await tx<{ id: string; title: string; status: BookStatus; totalPages: number | null }[]>`
        select id, title, status, total_pages from public.books where id = any(${bookIds}::uuid[])
      `
    : []
  const logsByBook = await listReadingLogsForBooks(
    tx,
    books.map((b) => b.id),
  )
  const bookById = new Map<string, LearningGoalView['book']>()
  for (const b of books) {
    const progress = readingProgress(b, logsByBook.get(b.id) ?? [])
    bookById.set(b.id, { id: b.id, title: b.title, status: b.status, progress })
  }

  const needsMinutes = goals.some((g) => g.dailyMinutes != null)
  const minutes = needsMinutes ? await readingMinutesOn(tx, day) : null

  return goals.map((goal) => {
    const h = goal.habitId ? habitById.get(goal.habitId) : undefined
    const habit: LearningGoalHabit | null = h
      ? { ...h, dueToday: h.active && !h.archived && h.weekdays.includes(weekday) }
      : null
    const book = goal.bookId ? (bookById.get(goal.bookId) ?? null) : null
    const minutesToday =
      goal.dailyMinutes == null || !minutes
        ? null
        : goal.bookId
          ? (minutes.byBook.get(goal.bookId) ?? 0)
          : minutes.total
    const summary = learningGoalSummary(
      {
        status: goal.status,
        targetDate: goal.targetDate,
        dailyMinutes: goal.dailyMinutes,
        book: book ? { status: book.status, progress: book.progress } : null,
        minutesToday,
      },
      day,
    )
    return { ...goal, habit, book, summary }
  })
}

/** Habits that can be linked as a goal's practice habit (not archived). */
export async function listPracticeHabitOptions(tx: Tx): Promise<PracticeHabitOption[]> {
  return tx<PracticeHabitOption[]>`
    select id, title, weekdays::int[] as weekdays, active
    from public.habits
    where archived_at is null
    order by active desc, lower(title), id
  `
}

/** Create a practice habit (e.g. "Read 30 minutes", every day) to link to a goal. */
export async function createPracticeHabit(
  tx: Tx,
  input: PracticeHabitInput,
): Promise<PracticeHabitOption> {
  const f = PracticeHabitInputSchema.parse(input)
  const [row] = await tx<PracticeHabitOption[]>`
    insert into public.habits (title, weekdays)
    values (${f.title}, ${f.weekdays}::smallint[])
    returning id, title, weekdays::int[] as weekdays, active
  `
  if (!row) throw new Error('insert into habits returned no row')
  return row
}
