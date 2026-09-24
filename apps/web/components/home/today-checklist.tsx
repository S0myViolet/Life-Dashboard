'use client'

/**
 * Today's tasks and habits with check-off. Changes are shown at once (optimistic) and saved
 * through the tasks area's server actions, which revalidate Home; a failure puts the item back
 * and says so.
 */
import Link from 'next/link'
import { useOptimistic, useState, useTransition } from 'react'
import { setTaskStatusAction, toggleHabitAction } from '@/lib/tasks/actions'
import type { HomeSourceResult, HomeTodayHabit, HomeTodayTask } from './view'

const linkClass =
  'inline-flex min-h-11 items-center font-medium text-accent hover:text-accent-strong sm:min-h-0'

type TasksData = { open: HomeTodayTask[]; doneToday: HomeTodayTask[]; more: number }
type HabitsData = { due: HomeTodayHabit[]; notDueCount: number }

export function TodayChecklist({
  today,
  tasks,
  habits,
}: {
  today: string
  tasks: HomeSourceResult<TasksData>
  habits: HomeSourceResult<HabitsData>
}) {
  const [, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [doneTasks, setTaskDone] = useOptimistic(
    new Map(
      tasks.ok ? [...tasks.data.open, ...tasks.data.doneToday].map((t) => [t.id, t.done]) : [],
    ),
    (state, change: { id: string; done: boolean }) => new Map(state).set(change.id, change.done),
  )
  const [doneHabits, setHabitDone] = useOptimistic(
    new Map(habits.ok ? habits.data.due.map((h) => [h.id, h.done]) : []),
    (state, change: { id: string; done: boolean }) => new Map(state).set(change.id, change.done),
  )

  const toggleTask = (task: HomeTodayTask, done: boolean) => {
    setError(null)
    startTransition(async () => {
      setTaskDone({ id: task.id, done })
      const r = await setTaskStatusAction(task.id, done ? 'complete' : 'reopen')
      if (!r.ok) setError(`“${task.title}” was not updated. ${r.message}`)
    })
  }
  const toggleHabit = (habit: HomeTodayHabit, done: boolean) => {
    setError(null)
    startTransition(async () => {
      setHabitDone({ id: habit.id, done })
      const r = await toggleHabitAction(habit.id, today, done)
      if (!r.ok) setError(`“${habit.title}” was not updated. ${r.message}`)
    })
  }

  return (
    <div className="space-y-4">
      <section aria-labelledby="today-tasks-title">
        <h3 id="today-tasks-title" className="text-sm font-medium text-ink">
          Tasks due today
        </h3>
        {!tasks.ok ? (
          <p role="alert" className="mt-1 text-danger">
            Today&rsquo;s tasks could not be loaded right now.
          </p>
        ) : tasks.data.open.length === 0 && tasks.data.doneToday.length === 0 ? (
          <p className="mt-1" data-testid="today-tasks-empty">
            No tasks are due today.{' '}
            <a href="#quick-capture" className={linkClass}>
              Add a task
            </a>
          </p>
        ) : (
          <ul className="mt-1" data-testid="today-tasks">
            {[...tasks.data.open, ...tasks.data.doneToday].map((task) => {
              const done = doneTasks.get(task.id) ?? task.done
              return (
                <li key={task.id} className="flex items-start gap-1">
                  <label className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg hover:bg-surface-muted">
                    <input
                      type="checkbox"
                      checked={done}
                      onChange={(e) => toggleTask(task, e.currentTarget.checked)}
                      aria-label={task.title}
                      className="size-5 cursor-pointer accent-[var(--color-positive)]"
                    />
                  </label>
                  <Link
                    href={task.href}
                    className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-x-2 rounded-lg px-1 hover:bg-surface-muted"
                  >
                    <span
                      className={`min-w-0 break-words ${done ? 'text-ink-muted line-through' : 'text-ink'}`}
                    >
                      {task.title}
                    </span>
                    {task.time ? (
                      <span className="font-mono text-xs tabular-nums text-ink-muted">
                        {task.time}
                      </span>
                    ) : null}
                    {task.priority === 1 ? (
                      <span className="text-xs font-medium text-danger">P1</span>
                    ) : null}
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
        {tasks.ok && tasks.data.more > 0 ? (
          <Link href="/plan/tasks" className={linkClass}>
            {tasks.data.more} more due today
          </Link>
        ) : null}
      </section>

      <section aria-labelledby="today-habits-title">
        <h3 id="today-habits-title" className="text-sm font-medium text-ink">
          Habits
        </h3>
        {!habits.ok ? (
          <p role="alert" className="mt-1 text-danger">
            Habits could not be loaded right now.
          </p>
        ) : habits.data.due.length === 0 ? (
          <p className="mt-1" data-testid="today-habits-empty">
            {habits.data.notDueCount > 0
              ? `None of your habits is scheduled today (${habits.data.notDueCount} on other days).`
              : 'No habits yet.'}{' '}
            <Link href="/plan/habits" className={linkClass}>
              {habits.data.notDueCount > 0 ? 'Habits' : 'Set up a habit'}
            </Link>
          </p>
        ) : (
          <ul className="mt-1" data-testid="today-habits">
            {habits.data.due.map((habit) => {
              const done = doneHabits.get(habit.id) ?? habit.done
              return (
                <li key={habit.id}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 hover:bg-surface-muted">
                    <input
                      type="checkbox"
                      checked={done}
                      onChange={(e) => toggleHabit(habit, e.currentTarget.checked)}
                      className="size-5 shrink-0 cursor-pointer accent-[var(--color-positive)]"
                    />
                    <span
                      className={`min-w-0 flex-1 break-words ${done ? 'text-ink-muted line-through' : 'text-ink'}`}
                    >
                      {habit.title}
                    </span>
                    <span className="shrink-0 text-xs text-ink-faint">{habit.weekdaysLabel}</span>
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <p aria-live="polite" className="text-sm text-danger empty:hidden">
        {error}
      </p>
    </div>
  )
}
