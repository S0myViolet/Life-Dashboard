/**
 * Home view models: plain, serialisable data shaped from the repositories' results, with every
 * date already formatted in the owner's timezone. Pure (no I/O), so the rules are unit-tested
 * in test/home-view.test.ts.
 *
 * Honesty rules applied here:
 *   - A source that failed is reported as failed, never as "nothing to show".
 *   - Needs attention always says which sources were checked and which are not connected yet,
 *     so an empty list is never presented as an all-clear.
 */
import {
  BriefingContentSchema,
  BriefingSourceFreshnessSchema,
  addLocalDays,
  briefingLocalTime,
  describeHabitWeekdays,
  isHabitDueOn,
  localDateInZone,
  localDaysBetween,
  localTimeInZone,
  nextLocalDailyRun,
  taskHref,
  type BriefingKind,
  type BriefingStatus,
  type TaskPriority,
  type TasksNeedsAttention,
} from '@personal-home/core'
import type { PeopleAttention } from '@personal-home/db'
import {
  formatDueLabel,
  formatInstantLabel,
  formatRelativeDate,
  formatShortDate,
} from '@/lib/tasks/format'

/** A source's result: its data, or the fact that it could not be read. */
export type HomeSourceResult<T> = { ok: true; data: T } | { ok: false }

export type HomeTone = 'danger' | 'caution' | 'accent' | 'neutral'

export interface HomeAttentionItem {
  key: string
  kind: 'task_overdue' | 'task_due_soon' | 'reminder_due' | 'person_date' | 'catch_up'
  title: string
  /** Short status label shown as a pill: "Overdue", "Due soon", "Reminder"... */
  label: string
  /** When, in the owner's timezone: "Due Tue 22 Sep", "Today · 13:00", "In 5 days · Tue 29 Sep". */
  detail: string
  href: string
  tone: HomeTone
}

export interface HomeAttentionView {
  items: HomeAttentionItem[]
  /** Items not shown because of the limit, per source (counts are complete). */
  more: { tasks: number; people: number }
  /** The owner's local sources and whether each could be read. */
  sources: { tasks: boolean; people: boolean }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function inDays(localDate: string, today: string): string {
  const n = localDaysBetween(today, localDate)
  if (n === 0) return 'Today'
  if (n === 1) return 'Tomorrow'
  return `In ${n} days`
}

/**
 * Merge the tasks/reminders attention list and the people attention list into one ordered
 * list: overdue tasks, due reminders and tasks due soon (in the tasks area's order), then
 * important dates inside the owner's own reminder window (soonest first), then catch-ups that
 * are due (most overdue first). Only owner-entered, verified items: nothing inferred.
 */
export function buildHomeAttention(input: {
  tasks: HomeSourceResult<TasksNeedsAttention>
  people: HomeSourceResult<PeopleAttention>
  now: Date
  tz: string
  limit: number
}): HomeAttentionView {
  const { now, tz } = input
  const today = localDateInZone(now, tz)
  const taskItems: HomeAttentionItem[] = []
  let taskTotal = 0
  if (input.tasks.ok) {
    const t = input.tasks.data
    taskTotal = t.counts.overdue + t.counts.dueSoon + t.counts.reminders
    for (const item of t.items) {
      if (item.kind === 'reminder_due') {
        taskItems.push({
          key: item.key,
          kind: 'reminder_due',
          title: item.title,
          label: 'Reminder',
          detail: formatInstantLabel(item.remindAt, now, tz),
          href: item.href,
          tone: 'accent',
        })
      } else {
        const due = formatDueLabel({ dueDate: item.dueDate, dueAt: item.dueAt }, now, tz) ?? ''
        taskItems.push({
          key: item.key,
          kind: item.kind,
          title: item.title,
          label: item.kind === 'task_overdue' ? 'Overdue' : 'Due soon',
          detail: item.kind === 'task_overdue' ? `Was due ${due}` : `Due ${due}`,
          href: item.href,
          tone: item.kind === 'task_overdue' ? 'danger' : 'caution',
        })
      }
    }
  }

  const peopleItems: HomeAttentionItem[] = []
  if (input.people.ok) {
    const p = input.people.data
    for (const d of p.upcomingDates) {
      if (!d.reminderDue) continue
      const turning =
        d.years != null && d.years > 0 && /birthday/i.test(d.label) ? ` · turns ${d.years}` : ''
      peopleItems.push({
        key: `date:${d.dateId}`,
        kind: 'person_date',
        title: `${d.personName} · ${d.label}`,
        label: d.daysUntil === 0 ? 'Today' : 'Coming up',
        detail: `${inDays(d.date, today)} · ${formatShortDate(d.date, today)}${turning}`,
        href: `/people/${d.personId}`,
        tone: d.daysUntil === 0 ? 'caution' : 'accent',
      })
    }
    for (const c of p.dueCatchUps) {
      peopleItems.push({
        key: `catchup:${c.personId}`,
        kind: 'catch_up',
        title: `Catch up with ${c.personName}`,
        label: 'Catch-up',
        detail:
          c.daysOverdue > 0
            ? `${plural(c.daysOverdue, 'day')} overdue · every ${plural(c.catchUpEveryDays, 'day')}`
            : `Due today · every ${plural(c.catchUpEveryDays, 'day')}`,
        href: `/people/${c.personId}`,
        tone: c.daysOverdue > 0 ? 'caution' : 'neutral',
      })
    }
  }

  // Fill the limit from tasks first (deadlines), then people; report what did not fit.
  const limit = Math.max(0, input.limit)
  const shownTasks = taskItems.slice(0, limit)
  const shownPeople = peopleItems.slice(0, Math.max(0, limit - shownTasks.length))
  return {
    items: [...shownTasks, ...shownPeople],
    more: {
      tasks: Math.max(0, taskTotal - shownTasks.length),
      people: peopleItems.length - shownPeople.length,
    },
    sources: { tasks: input.tasks.ok, people: input.people.ok },
  }
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

export interface HomeTodayTask {
  id: string
  title: string
  /** "13:00" for a timed task, null for a date-only one. */
  time: string | null
  priority: TaskPriority | null
  done: boolean
  href: string
}

export interface HomeTodayHabit {
  id: string
  title: string
  weekdaysLabel: string
  done: boolean
}

export interface HomeTodayView {
  today: string
  todayLabel: string
  tasks: HomeSourceResult<{ open: HomeTodayTask[]; doneToday: HomeTodayTask[]; more: number }>
  habits: HomeSourceResult<{ due: HomeTodayHabit[]; notDueCount: number }>
}

interface TaskLike {
  id: string
  title: string
  status: string
  dueAt: Date | null
  priority: number | null
  completedAt: Date | null
}

const asPriority = (p: number | null): TaskPriority | null =>
  p === 1 || p === 2 || p === 3 || p === 4 ? p : null

function todayTask(t: TaskLike, tz: string): HomeTodayTask {
  return {
    id: t.id,
    title: t.title,
    time: t.dueAt ? localTimeInZone(t.dueAt, tz) : null,
    priority: asPriority(t.priority),
    done: t.status === 'done',
    href: taskHref(t.id),
  }
}

/**
 * Tasks due today (open, from the tasks area's "today" filter, so overdue ones stay in Needs
 * attention), tasks completed today (so a check-off can be undone), and active habits scheduled
 * today with whether they are done.
 */
export function buildHomeToday(input: {
  now: Date
  tz: string
  limit: number
  openToday: HomeSourceResult<readonly TaskLike[]>
  recentlyDone: HomeSourceResult<readonly TaskLike[]>
  habits: HomeSourceResult<{
    habits: readonly { id: string; title: string; weekdays: number[]; active: boolean }[]
    doneToday: ReadonlySet<string>
  }>
}): HomeTodayView {
  const { now, tz } = input
  const today = localDateInZone(now, tz)
  let tasks: HomeTodayView['tasks'] = { ok: false }
  if (input.openToday.ok && input.recentlyDone.ok) {
    const open = input.openToday.data.map((t) => todayTask(t, tz))
    const doneToday = input.recentlyDone.data
      .filter(
        (t) => t.status === 'done' && t.completedAt && localDateInZone(t.completedAt, tz) === today,
      )
      .slice(0, 3)
      .map((t) => todayTask(t, tz))
    tasks = {
      ok: true,
      data: {
        open: open.slice(0, input.limit),
        doneToday,
        more: Math.max(0, open.length - input.limit),
      },
    }
  }
  let habits: HomeTodayView['habits'] = { ok: false }
  if (input.habits.ok) {
    const active = input.habits.data.habits.filter((h) => h.active)
    const due = active.filter((h) => isHabitDueOn(h.weekdays, today))
    habits = {
      ok: true,
      data: {
        due: due.map((h) => ({
          id: h.id,
          title: h.title,
          weekdaysLabel: describeHabitWeekdays(h.weekdays),
          done: input.habits.ok && input.habits.data.doneToday.has(h.id),
        })),
        notDueCount: active.length - due.length,
      },
    }
  }
  return { today, todayLabel: formatRelativeDate(today, today), tasks, habits }
}

// ---------------------------------------------------------------------------
// Latest briefing
// ---------------------------------------------------------------------------

export interface HomeBriefingRow {
  kind: BriefingKind
  localDate: string
  scheduledFor: Date
  status: BriefingStatus
  publishedAt: Date | null
  isLate: boolean
  content: Record<string, unknown>
  sourceFreshness: Record<string, unknown>
}

/** A briefing older than this is labelled out of date (two schedules a day, so ~a day's gap). */
export const HOME_BRIEFING_STALE_MS = 26 * 3_600_000

export interface HomeBriefingPublished {
  title: string
  /** "Today", "Yesterday" or "Wed 23 Sep". */
  dateLabel: string
  /** "Published 11:00" or "Published Yesterday · 23:40". */
  publishedLabel: string
  late: boolean
  /** Older than a day: a newer briefing should exist. */
  stale: boolean
  /** "Scheduled for 11:00" (shown with the late label). */
  scheduledLabel: string
  summary: string | null
  sections: { key: string; title: string; availableIn: string }[]
  /** How many sources the briefing read, and its note about them. */
  sourceCount: number
  sourceNote: string | null
  /** False when the stored content could not be read with the current schema. */
  readable: boolean
}

export interface HomeBriefingView {
  latest: HomeBriefingPublished | null
  /** A newer briefing that failed or is still being prepared, stated plainly. */
  newerProblem: string | null
  /** "11:00 briefing and 22:00 project review" in the owner's timezone. */
  scheduleLabel: string
  /** The next scheduled publication, when the timezone is confirmed. */
  nextLabel: string | null
  timezoneConfirmed: boolean
}

const KIND_TITLE: Record<BriefingKind, string> = {
  morning: 'Morning briefing',
  evening: 'Evening project review',
}

export function buildHomeBriefing(input: {
  latestPublished: HomeBriefingRow | null
  mostRecent: HomeBriefingRow | null
  now: Date
  tz: string
  timezoneConfirmed: boolean
}): HomeBriefingView {
  const { now, tz } = input
  const today = localDateInZone(now, tz)
  const morning = briefingLocalTime('morning')
  const evening = briefingLocalTime('evening')

  let latest: HomeBriefingPublished | null = null
  const row = input.latestPublished
  if (row && row.status === 'published' && row.publishedAt) {
    const content = BriefingContentSchema.safeParse(row.content)
    const freshness = BriefingSourceFreshnessSchema.safeParse(row.sourceFreshness)
    latest = {
      title: content.success ? content.data.title : KIND_TITLE[row.kind],
      dateLabel: formatRelativeDate(row.localDate, today),
      publishedLabel: `Published ${
        localDateInZone(row.publishedAt, tz) === today
          ? localTimeInZone(row.publishedAt, tz)
          : formatInstantLabel(row.publishedAt, now, tz)
      }`,
      late: row.isLate,
      stale: now.getTime() - row.publishedAt.getTime() > HOME_BRIEFING_STALE_MS,
      scheduledLabel: `Scheduled for ${localTimeInZone(row.scheduledFor, tz)}`,
      summary: content.success ? content.data.summary : null,
      sections: content.success
        ? content.data.sections.map((s) => ({
            key: s.key,
            title: s.title,
            availableIn: s.availableIn,
          }))
        : [],
      sourceCount: freshness.success ? freshness.data.sources.length : 0,
      sourceNote: freshness.success ? freshness.data.note : null,
      readable: content.success,
    }
  }

  let newerProblem: string | null = null
  const recent = input.mostRecent
  if (
    recent &&
    recent.status !== 'published' &&
    (!row || recent.scheduledFor.getTime() > row.scheduledFor.getTime())
  ) {
    const which = `${KIND_TITLE[recent.kind].toLowerCase()} for ${formatRelativeDate(recent.localDate, today).replace(/^(Today|Yesterday|Tomorrow)$/, (m) => m.toLowerCase())}`
    newerProblem =
      recent.status === 'failed'
        ? `The ${which} could not be prepared.`
        : `The ${which} is being prepared.`
  }

  let nextLabel: string | null = null
  if (input.timezoneConfirmed) {
    const nextMorning = nextLocalDailyRun(now, morning, tz)
    const nextEvening = nextLocalDailyRun(now, evening, tz)
    const [at, kind] =
      nextMorning.getTime() <= nextEvening.getTime()
        ? [nextMorning, 'briefing']
        : [nextEvening, 'project review']
    const day = localDateInZone(at, tz)
    const when =
      day === today
        ? `today at ${localTimeInZone(at, tz)}`
        : day === addLocalDays(today, 1)
          ? `tomorrow at ${localTimeInZone(at, tz)}`
          : `${formatShortDate(day, today)} at ${localTimeInZone(at, tz)}`
    nextLabel = `Next ${kind}: ${when}`
  }

  return {
    latest,
    newerProblem,
    scheduleLabel: `${morning} briefing and ${evening} project review`,
    nextLabel,
    timezoneConfirmed: input.timezoneConfirmed,
  }
}
