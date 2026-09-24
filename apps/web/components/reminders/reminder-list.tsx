'use client'

/**
 * Plan › Tasks › Reminders: due reminders (dismiss), upcoming ones (delete),
 * and a form for a new reminder. In Milestone 1 reminders are shown in the
 * app only; phone notifications arrive with Web Push in Milestone 2.
 */
import { useActionState, useEffect, useOptimistic, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { BellRing, Repeat } from 'lucide-react'
import { REMINDER_RECURRENCES, REMINDER_RECURRENCE_LABELS, taskHref } from '@personal-home/core'
import { buttonClass } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { FieldError, FormStatus, inputClass, labelClass } from '@/components/tasks/ui'
import {
  createReminderAction,
  deleteReminderAction,
  dismissReminderAction,
} from '@/lib/tasks/actions'
import { TASKS_FORM_IDLE, type TasksFormState } from '@/lib/tasks/forms'
import type { ReminderListData, ReminderView } from '@/lib/tasks/view-types'

export function ReminderList({ data }: { data: ReminderListData }) {
  const [items, removeOptimistically] = useOptimistic(
    [...data.due, ...data.upcoming],
    (state: ReminderView[], id: string) => state.filter((r) => r.id !== id),
  )
  const [, startTransition] = useTransition()
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const due = items.filter((r) => r.due)
  const upcoming = items.filter((r) => !r.due)

  const dismiss = (r: ReminderView) =>
    startTransition(async () => {
      if (!r.recurrenceLabel) removeOptimistically(r.id)
      const res = await dismissReminderAction(r.id)
      setMessage({ text: res.message ?? 'Reminder dismissed.', error: !res.ok })
    })
  const remove = (r: ReminderView) =>
    startTransition(async () => {
      removeOptimistically(r.id)
      const res = await deleteReminderAction(r.id)
      setMessage({ text: res.message ?? 'Reminder deleted.', error: !res.ok })
    })

  return (
    <Card as="section" id="reminders" aria-labelledby="reminders-heading" className="scroll-mt-6">
      <h2 id="reminders-heading" className="text-[15px] font-semibold tracking-tight text-ink">
        Reminders
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        Shown here and on Home when due. Phone notifications are not set up yet.
      </p>
      <div aria-live="polite" className="mt-2 text-sm">
        {message ? (
          <p className={message.error ? 'text-danger' : 'text-positive'}>{message.text}</p>
        ) : null}
      </div>

      {due.length > 0 ? (
        <div className="mt-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-caution">
            <BellRing aria-hidden className="size-4" />
            Due now
          </h3>
          <ul className="mt-1 divide-y divide-line">
            {due.map((r) => (
              <ReminderItem key={r.id} reminder={r}>
                <button
                  type="button"
                  className={buttonClass('secondary', 'shrink-0 px-3')}
                  aria-label={`Dismiss reminder: ${r.title}`}
                  onClick={() => dismiss(r)}
                >
                  {r.recurrenceLabel ? 'Done for now' : 'Dismiss'}
                </button>
              </ReminderItem>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-3">
        <h3 className="text-sm font-semibold text-ink">Upcoming</h3>
        {upcoming.length === 0 ? (
          <p className="mt-1 text-sm text-ink-muted">No upcoming reminders.</p>
        ) : (
          <ul className="mt-1 divide-y divide-line">
            {upcoming.map((r) => (
              <ReminderItem key={r.id} reminder={r}>
                <ConfirmDelete label={r.title} onConfirm={() => remove(r)} />
              </ReminderItem>
            ))}
          </ul>
        )}
      </div>

      <AddReminder today={data.today} tz={data.tz} />
    </Card>
  )
}

function ReminderItem({
  reminder: r,
  children,
}: {
  reminder: ReminderView
  children: React.ReactNode
}) {
  return (
    <li className="flex items-start justify-between gap-2 py-2">
      <div className="min-w-0 pt-1">
        <p className="break-words text-[15px] text-ink">{r.title}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-ink-muted">
          <span>{r.whenLabel}</span>
          {r.recurrenceLabel ? (
            <span className="inline-flex items-center gap-1">
              <Repeat aria-hidden className="size-3.5" />
              {r.recurrenceLabel}
            </span>
          ) : null}
          {r.taskId ? (
            <Link
              href={taskHref(r.taskId)}
              className="inline-flex min-h-11 items-center text-accent hover:text-accent-strong sm:min-h-0"
            >
              Open task<span className="sr-only">: {r.title}</span>
            </Link>
          ) : null}
        </p>
      </div>
      {children}
    </li>
  )
}

function ConfirmDelete({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!confirming) return
    confirmRef.current?.focus()
    const timer = setTimeout(() => setConfirming(false), 6000)
    return () => clearTimeout(timer)
  }, [confirming])
  if (!confirming) {
    return (
      <button
        type="button"
        className={buttonClass('ghost', 'shrink-0 px-3')}
        aria-label={`Delete reminder: ${label}`}
        onClick={() => setConfirming(true)}
      >
        Delete
      </button>
    )
  }
  return (
    <button
      ref={confirmRef}
      type="button"
      className={buttonClass('danger', 'shrink-0 px-3')}
      aria-label={`Confirm deleting reminder: ${label}`}
      onClick={onConfirm}
      onBlur={() => setConfirming(false)}
    >
      Confirm delete
    </button>
  )
}

function AddReminder({ today, tz }: { today: string; tz: string }) {
  const [state, action, pending] = useActionState(createReminderAction, TASKS_FORM_IDLE)
  const key = state.status === 'idle' ? 'initial' : state.stamp
  return (
    <details
      className="mt-4 border-t border-line pt-3"
      open={state.status === 'error' || undefined}
    >
      <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-1 text-sm font-medium text-accent hover:text-accent-strong">
        New reminder
      </summary>
      <AddReminderForm
        key={key}
        state={state}
        action={action}
        pending={pending}
        today={today}
        tz={tz}
      />
      <div aria-live="polite" className="mt-2">
        <FormStatus state={state} />
      </div>
    </details>
  )
}

function AddReminderForm({
  state,
  action,
  pending,
  today,
  tz,
}: {
  state: TasksFormState
  action: (formData: FormData) => void
  pending: boolean
  today: string
  tz: string
}) {
  const values = state.status === 'error' ? state.values : {}
  const errors = state.status === 'error' ? state.fieldErrors : {}
  const formRef = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (state.status === 'error') {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    }
  }, [state])
  const err = (name: string) => ({
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby': errors[name] ? `reminder-${name}-error` : undefined,
  })
  return (
    <form ref={formRef} action={action} className="mt-2 space-y-3">
      <div>
        <label htmlFor="reminder-title" className={labelClass}>
          Remind me to
        </label>
        <input
          id="reminder-title"
          name="title"
          required
          maxLength={300}
          autoComplete="off"
          defaultValue={values.title ?? ''}
          className={inputClass}
          {...err('title')}
        />
        <FieldError id="reminder-title-error" message={errors.title} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="reminder-date" className={labelClass}>
            Date
          </label>
          <input
            id="reminder-date"
            name="date"
            type="date"
            required
            defaultValue={values.date ?? today}
            className={inputClass}
            {...err('date')}
          />
          <FieldError id="reminder-date-error" message={errors.date} />
        </div>
        <div>
          <label htmlFor="reminder-time" className={labelClass}>
            Time
          </label>
          <input
            id="reminder-time"
            name="time"
            type="time"
            required
            defaultValue={values.time ?? ''}
            className={inputClass}
            {...err('time')}
          />
          <FieldError id="reminder-time-error" message={errors.time} />
        </div>
      </div>
      <div>
        <label htmlFor="reminder-recurrence" className={labelClass}>
          Repeat
        </label>
        <select
          id="reminder-recurrence"
          name="recurrence"
          defaultValue={values.recurrence ?? ''}
          className={inputClass}
          {...err('recurrence')}
        >
          <option value="">Does not repeat</option>
          {REMINDER_RECURRENCES.map((r) => (
            <option key={r} value={r}>
              {REMINDER_RECURRENCE_LABELS[r]}
            </option>
          ))}
        </select>
        <FieldError id="reminder-recurrence-error" message={errors.recurrence} />
      </div>
      <p className="text-sm text-ink-muted">Times are in {tz}.</p>
      <button type="submit" disabled={pending} className={buttonClass('primary')}>
        {pending ? 'Saving…' : 'Add reminder'}
      </button>
    </form>
  )
}
