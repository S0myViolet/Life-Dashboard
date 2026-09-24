import Link from 'next/link'
import { formatReadingPercent, LEARNING_GOAL_STATUS_LABELS } from '@personal-home/core'
import {
  listBookOptions,
  listLearningGoals,
  listPracticeHabitOptions,
  type LearningGoalView,
} from '@personal-home/db'
import { Card, CardHeader } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Pill } from '@/components/ui/status-pill'
import { withOwnerTx } from '@/lib/server/session'
import { formatLocalDate, plural, relativeDay } from './format'
import { GoalForm } from './goal-form'
import { ownerToday } from './owner-today'

/** Plain-language lines for a goal: target, pace, minutes, practice habit. */
export function goalLines(goal: LearningGoalView, today: string): string[] {
  const s = goal.summary
  const lines: string[] = []
  if (goal.targetDate) {
    const when = formatLocalDate(goal.targetDate, { today })
    if (s.targetState === 'reached') lines.push(`Target ${when}`)
    else if (s.targetState === 'overdue')
      lines.push(`Target was ${when} (${relativeDay(goal.targetDate, today)})`)
    else lines.push(`Target ${when} · ${relativeDay(goal.targetDate, today)}`)
  }
  if (goal.book) {
    const finished = goal.book.status === 'finished'
    lines.push(finished ? `Book: ${goal.book.title} (finished)` : `Book: ${goal.book.title}`)
  }
  const atEnd =
    (s.pace?.kind === 'pages' && s.pace.pagesLeft === 0) ||
    (s.pace?.kind === 'percent' && s.pace.percentLeft === 0)
  if (atEnd) {
    lines.push('At the end of the book — mark it finished to close this goal.')
  } else if (s.pace?.kind === 'pages') {
    lines.push(
      `${plural(s.pace.perDay, 'page')} a day to finish on time (${s.pace.pagesLeft} left)`,
    )
  } else if (s.pace?.kind === 'percent') {
    lines.push(`${formatReadingPercent(s.pace.perDay)} a day to finish on time`)
  } else if (s.paceMissing === 'no_progress') {
    lines.push('Log progress with the total pages or a percentage to see the pace needed.')
  }
  if (s.minutes) {
    lines.push(
      `Today: ${s.minutes.today} of ${s.minutes.target} min read${s.minutes.met ? ' — done' : ''}`,
    )
  }
  if (goal.habit) {
    const h = goal.habit
    const state = h.archived
      ? 'archived'
      : !h.active
        ? 'paused'
        : h.doneToday
          ? 'done today'
          : h.dueToday
            ? 'due today'
            : 'not scheduled today'
    lines.push(`Practice: ${h.title} · ${state}`)
  }
  return lines
}

function GoalItem({ goal, today }: { goal: LearningGoalView; today: string }) {
  const lines = goalLines(goal, today)
  const overdue = goal.summary.targetState === 'overdue'
  return (
    <li className="space-y-1 py-3 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 text-[15px] font-medium text-ink">
          <Link
            href={`/learning/goals/${goal.id}`}
            className="inline-flex min-h-11 items-center rounded-sm hover:text-accent-strong hover:underline sm:min-h-0"
          >
            {goal.title}
          </Link>
        </h3>
        {goal.status !== 'active' ? (
          <Pill tone={goal.status === 'done' ? 'positive' : 'caution'}>
            {LEARNING_GOAL_STATUS_LABELS[goal.status]}
          </Pill>
        ) : overdue ? (
          <Pill tone="caution">Past target</Pill>
        ) : null}
      </div>
      {lines.map((line) => (
        <p key={line} className="text-sm text-ink-muted">
          {line}
        </p>
      ))}
    </li>
  )
}

/** Learning goals with an add form. Loads independently of the reading list. */
export async function GoalsSection() {
  const { goals, books, habits, today } = await withOwnerTx(async (tx) => {
    const { today } = await ownerToday(tx)
    const [goals, books, habits] = [
      await listLearningGoals(tx, today),
      await listBookOptions(tx),
      await listPracticeHabitOptions(tx),
    ]
    return { goals, books, habits, today }
  })
  const open = goals.filter((g) => g.status !== 'done')
  const done = goals.filter((g) => g.status === 'done')

  return (
    <Card aria-labelledby="goals-title">
      <CardHeader
        id="goals-title"
        title="Learning goals"
        meta={open.length ? plural(open.length, 'goal') : undefined}
      />
      {open.length ? (
        <ul className="divide-y divide-line">
          {open.map((g) => (
            <GoalItem key={g.id} goal={g} today={today} />
          ))}
        </ul>
      ) : (
        <EmptyState title="No learning goals yet">
          A goal can have a target date, a book to finish, reading minutes a day or a practice
          habit.
        </EmptyState>
      )}
      {done.length ? (
        <details className="mt-3">
          <summary className="flex min-h-11 cursor-pointer items-center text-sm text-accent hover:text-accent-strong">
            Done ({done.length})
          </summary>
          <ul className="divide-y divide-line">
            {done.map((g) => (
              <GoalItem key={g.id} goal={g} today={today} />
            ))}
          </ul>
        </details>
      ) : null}
      <details className="mt-4 rounded-xl border border-line bg-surface-muted/40 px-3 open:pb-3">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-accent hover:text-accent-strong">
          Add a goal
        </summary>
        <div className="pt-1">
          <GoalForm
            books={books.map((b) => ({ id: b.id, title: b.title }))}
            habits={habits.map((h) => ({ id: h.id, title: h.title }))}
          />
        </div>
      </details>
    </Card>
  )
}
