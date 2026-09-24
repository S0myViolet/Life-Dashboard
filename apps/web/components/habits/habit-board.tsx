'use client'

/**
 * Plan › Habits: today's check-offs (optimistic toggles), a form for a new
 * habit, each habit's weekday chips, streak and 8-week history, the edit sheet,
 * and archived habits.
 */
import { useCallback, useOptimistic, useState, useTransition } from 'react'
import { Check, Flame } from 'lucide-react'
import { HABIT_WEEKDAY_LABELS, ISO_WEEKDAYS } from '@personal-home/core'
import { buttonClass } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Sheet, Toast, useToast } from '@/components/tasks/ui'
import { archiveHabitAction, deleteHabitAction, toggleHabitAction } from '@/lib/tasks/actions'
import type { HabitView, HabitsData } from '@/lib/tasks/view-types'
import { HabitForm } from './habit-form'
import { HabitHistory } from './habit-history'

export function HabitBoard({ data }: { data: HabitsData }) {
  const [habits, setOptimisticDone] = useOptimistic(
    data.habits,
    (state: HabitView[], change: { id: string; done: boolean }) =>
      state.map((h) => (h.id === change.id ? { ...h, doneToday: change.done } : h)),
  )
  const [, startTransition] = useTransition()
  const { toast, show, dismiss, timeoutMs } = useToast()
  const [editingId, setEditingId] = useState<string | null>(null)
  const editing = editingId ? (data.habits.find((h) => h.id === editingId) ?? null) : null

  const toggle = useCallback(
    (habit: HabitView) => {
      const done = !habit.doneToday
      startTransition(async () => {
        setOptimisticDone({ id: habit.id, done })
        const r = await toggleHabitAction(habit.id, data.today, done)
        if (!r.ok) show({ message: r.message, tone: 'error' })
      })
    },
    [data.today, setOptimisticDone, show],
  )

  const runAction = (fn: () => Promise<{ ok: boolean; message?: string }>, after?: () => void) =>
    startTransition(async () => {
      const r = await fn()
      if (r.ok) after?.()
      show({
        message: r.message ?? (r.ok ? 'Done.' : 'Something went wrong.'),
        tone: r.ok ? 'neutral' : 'error',
      })
    })

  const dueToday = habits.filter((h) => h.dueToday)
  const notDueToday = habits.filter((h) => !h.dueToday)

  return (
    <div className="space-y-4">
      <Card as="section" aria-labelledby="habits-today-heading">
        <h2 id="habits-today-heading" className="text-[15px] font-semibold tracking-tight text-ink">
          Today <span className="font-normal text-ink-muted">· {data.todayLabel}</span>
        </h2>
        {habits.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">Add a habit below to check it off here.</p>
        ) : dueToday.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">No habits are scheduled for today.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {dueToday.map((h) => (
              <li key={h.id}>
                <CheckOff habit={h} onToggle={toggle} />
              </li>
            ))}
          </ul>
        )}
        {notDueToday.length > 0 ? (
          <details className="mt-3">
            <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-1 text-sm text-ink-muted hover:text-ink">
              Not scheduled today ({notDueToday.length})
            </summary>
            <ul className="mt-1 space-y-1">
              {notDueToday.map((h) => (
                <li key={h.id}>
                  <CheckOff habit={h} onToggle={toggle} extra />
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Card>

      <Card as="section" aria-labelledby="habit-new-heading">
        <h2 id="habit-new-heading" className="sr-only">
          Add a habit
        </h2>
        <HabitForm mode="create" prefix="habit-new" />
      </Card>

      {habits.length === 0 ? (
        <EmptyState title="No habits yet">
          Pick the days a habit applies to; each day you check it off builds its history here.
        </EmptyState>
      ) : (
        <section aria-labelledby="habits-all-heading" className="space-y-4">
          <h2 id="habits-all-heading" className="sr-only">
            Your habits
          </h2>
          {habits.map((h) => (
            <HabitCard key={h.id} habit={h} onEdit={() => setEditingId(h.id)} />
          ))}
        </section>
      )}

      {data.archived.length > 0 ? (
        <Card as="div">
          <details>
            <summary className="flex min-h-11 cursor-pointer items-center rounded-lg text-[15px] font-semibold tracking-tight text-ink">
              <h2 className="inline">Archived ({data.archived.length})</h2>
            </summary>
            <ul className="mt-2 divide-y divide-line">
              {data.archived.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0 break-words text-[15px] text-ink-muted">{h.title}</span>
                  <span className="flex gap-2">
                    <button
                      type="button"
                      className={buttonClass('secondary', 'px-3')}
                      aria-label={`Restore ${h.title}`}
                      onClick={() => runAction(() => archiveHabitAction(h.id, false))}
                    >
                      Restore
                    </button>
                    <DeleteHabitButton
                      habit={h}
                      onDelete={() => runAction(() => deleteHabitAction(h.id))}
                    />
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </Card>
      ) : null}

      <Sheet
        open={editing !== null}
        onClose={() => setEditingId(null)}
        title="Edit habit"
        titleId="edit-habit-heading"
      >
        {editing ? (
          <div className="space-y-4">
            <HabitForm
              key={editing.id}
              mode="update"
              prefix="habit-edit"
              habit={editing}
              onSaved={(message) => {
                setEditingId(null)
                show({ message })
              }}
            />
            <div className="flex flex-wrap gap-2 border-t border-line pt-3">
              <button
                type="button"
                className={buttonClass('secondary')}
                onClick={() =>
                  runAction(
                    () => archiveHabitAction(editing.id, true),
                    () => setEditingId(null),
                  )
                }
              >
                Archive habit
              </button>
              <DeleteHabitButton
                habit={editing}
                onDelete={() =>
                  runAction(
                    () => deleteHabitAction(editing.id),
                    () => setEditingId(null),
                  )
                }
              />
            </div>
            <p className="text-sm text-ink-muted">
              Archiving hides the habit and keeps its history. Deleting removes both.
            </p>
          </div>
        ) : null}
      </Sheet>
      <Toast toast={toast} dismiss={dismiss} timeoutMs={timeoutMs} />
    </div>
  )
}

function CheckOff({
  habit,
  onToggle,
  extra,
}: {
  habit: HabitView
  onToggle: (h: HabitView) => void
  extra?: boolean
}) {
  return (
    <button
      type="button"
      aria-pressed={habit.doneToday}
      onClick={() => onToggle(habit)}
      className="flex min-h-11 w-full items-center gap-3 rounded-xl px-2 text-left hover:bg-surface-muted"
    >
      <span
        aria-hidden
        className={`inline-flex size-6 shrink-0 items-center justify-center rounded-md border-2 ${
          habit.doneToday
            ? 'border-positive bg-positive text-white'
            : 'border-line-strong text-transparent'
        }`}
      >
        <Check className="size-4" strokeWidth={3} />
      </span>
      <span
        className={`min-w-0 break-words text-[15px] ${habit.doneToday ? 'text-ink-muted' : 'text-ink'}`}
      >
        {habit.title}
      </span>
      <span className="sr-only">
        {habit.doneToday ? ', done today' : ', not done today'}
        {extra ? ' (not scheduled today)' : ''}
      </span>
    </button>
  )
}

function HabitCard({ habit, onEdit }: { habit: HabitView; onEdit: () => void }) {
  const streak = habit.currentStreakIsLowerBound
    ? `${habit.currentStreak}+`
    : String(habit.currentStreak)
  return (
    <Card as="article" aria-labelledby={`habit-${habit.id}-title`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3
            id={`habit-${habit.id}-title`}
            className="break-words text-[15px] font-semibold text-ink"
          >
            {habit.title}
          </h3>
          <p className="mt-0.5 text-sm text-ink-muted">{habit.weekdaysLabel}</p>
        </div>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={`Edit ${habit.title}`}
          className={buttonClass('ghost', 'shrink-0 px-3')}
          onClick={onEdit}
        >
          Edit
        </button>
      </div>
      <ul className="mt-2 flex gap-1" aria-label="Scheduled days">
        {ISO_WEEKDAYS.map((d) => {
          const on = habit.weekdays.includes(d)
          return (
            <li
              key={d}
              className={`inline-flex h-6 min-w-8 items-center justify-center rounded-md px-1 text-xs ${
                on ? 'bg-accent-soft font-medium text-accent-strong' : 'text-ink-faint line-through'
              }`}
            >
              <span aria-hidden>{HABIT_WEEKDAY_LABELS[d].short.slice(0, 2)}</span>
              <span className="sr-only">
                {HABIT_WEEKDAY_LABELS[d].long}: {on ? 'scheduled' : 'not scheduled'}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-muted">
        <span className="inline-flex items-center gap-1">
          <Flame aria-hidden className="size-4 text-caution" />
          Streak: <span className="font-medium text-ink">{streak}</span>
          {habit.currentStreakIsLowerBound ? <span className="sr-only">or more</span> : null}
        </span>
        <span>
          Last {habit.weeks.length} weeks: {habit.completedScheduledDays} of {habit.scheduledDays}{' '}
          scheduled days done
          {habit.missedDays > 0 ? `, ${habit.missedDays} missed` : ''}
          {habit.extraCompletions > 0 ? ` (+${habit.extraCompletions} extra)` : ''}
        </span>
      </p>
      {habit.details ? (
        <p className="mt-2 whitespace-pre-line text-sm text-ink-muted">{habit.details}</p>
      ) : null}
      <HabitHistory habit={habit} />
    </Card>
  )
}

function DeleteHabitButton({ habit, onDelete }: { habit: HabitView; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false)
  if (!confirming) {
    return (
      <button
        type="button"
        className={buttonClass('ghost', 'px-3')}
        aria-label={`Delete ${habit.title}`}
        onClick={() => setConfirming(true)}
      >
        Delete…
      </button>
    )
  }
  return (
    <span
      className="inline-flex flex-wrap items-center gap-2"
      role="group"
      aria-label="Confirm delete"
    >
      <button
        type="button"
        autoFocus
        className={buttonClass('danger', 'px-3')}
        aria-label={`Delete ${habit.title} and its history`}
        onClick={onDelete}
      >
        Delete with history
      </button>
      <button
        type="button"
        className={buttonClass('secondary', 'px-3')}
        onClick={() => setConfirming(false)}
      >
        Keep
      </button>
    </span>
  )
}
