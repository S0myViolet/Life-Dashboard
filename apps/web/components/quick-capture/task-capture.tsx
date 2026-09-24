'use client'

/**
 * Quick capture › Task: a title and an optional due date and time, saved through the tasks
 * area's createTaskAction (same validation, owner timezone and revalidation of Home). After a
 * save the form clears and the title keeps focus for the next entry; after an error it keeps
 * what was typed and focuses the field to fix.
 */
import Link from 'next/link'
import { useActionState, useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { buttonClass } from '@/components/ui/button'
import { FieldError, FormStatus, inputClass, labelClass } from '@/components/tasks/ui'
import { createTaskAction } from '@/lib/tasks/actions'
import { TASKS_FORM_IDLE, type TasksFormState } from '@/lib/tasks/forms'

export function TaskCapture({
  today,
  tomorrow,
  tz,
  autoFocus,
}: {
  today: string
  tomorrow: string
  tz: string
  autoFocus?: boolean
}) {
  const [state, action, pending] = useActionState(createTaskAction, TASKS_FORM_IDLE)
  const formKey = state.status === 'idle' ? 'initial' : state.stamp
  return (
    <div className="space-y-2">
      <TaskCaptureForm
        key={formKey}
        state={state}
        action={action}
        pending={pending}
        today={today}
        tomorrow={tomorrow}
        tz={tz}
        autoFocus={autoFocus}
      />
      <div aria-live="polite" className="text-sm">
        <FormStatus state={state} />
        {state.status === 'saved' ? (
          <Link
            href="/plan/tasks"
            className="inline-flex min-h-11 items-center font-medium text-accent hover:text-accent-strong sm:min-h-0"
          >
            Open Tasks
          </Link>
        ) : null}
      </div>
    </div>
  )
}

function TaskCaptureForm({
  state,
  action,
  pending,
  today,
  tomorrow,
  tz,
  autoFocus,
}: {
  state: TasksFormState
  action: (formData: FormData) => void
  pending: boolean
  today: string
  tomorrow: string
  tz: string
  autoFocus?: boolean
}) {
  const values = state.status === 'error' ? state.values : {}
  const errors = state.status === 'error' ? state.fieldErrors : {}
  const [dueDate, setDueDate] = useState(values.dueDate ?? '')
  const [dueTime, setDueTime] = useState(values.dueTime ?? '')
  const formRef = useRef<HTMLFormElement>(null)

  // Remounted per response: focus the title after a save, the first bad field after an error.
  useEffect(() => {
    const form = formRef.current
    if (!form) return
    if (state.status === 'saved' || (state.status === 'idle' && autoFocus)) {
      form.querySelector<HTMLInputElement>('input[name="title"]')?.focus()
    } else if (state.status === 'error') {
      form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    }
  }, [state, autoFocus])

  return (
    <form
      ref={formRef}
      action={action}
      noValidate
      aria-label="Add a task"
      className="space-y-3"
      data-testid="quick-task-form"
    >
      <div>
        <label htmlFor="qc-task-title" className={labelClass}>
          Task
        </label>
        <input
          id="qc-task-title"
          name="title"
          required
          maxLength={300}
          autoComplete="off"
          enterKeyHint="done"
          placeholder="What needs doing?"
          defaultValue={values.title ?? ''}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? 'qc-task-title-error' : undefined}
          className={inputClass}
        />
        <FieldError id="qc-task-title-error" message={errors.title} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <div>
          <label htmlFor="qc-task-date" className={labelClass}>
            Due date <span className="font-normal text-ink-faint">(optional)</span>
          </label>
          <input
            id="qc-task-date"
            name="dueDate"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            aria-invalid={errors.dueDate ? true : undefined}
            aria-describedby={errors.dueDate ? 'qc-task-date-error' : undefined}
            className={inputClass}
          />
          <FieldError id="qc-task-date-error" message={errors.dueDate} />
        </div>
        <div>
          <label htmlFor="qc-task-time" className={labelClass}>
            Time <span className="font-normal text-ink-faint">(optional)</span>
          </label>
          <input
            id="qc-task-time"
            name="dueTime"
            type="time"
            value={dueTime}
            onChange={(e) => {
              setDueTime(e.target.value)
              // A time needs a day: assume today until another date is picked.
              if (e.target.value && !dueDate) setDueDate(today)
            }}
            aria-invalid={errors.dueTime ? true : undefined}
            aria-describedby={errors.dueTime ? 'qc-task-time-error' : 'qc-task-time-help'}
            className={inputClass}
          />
          {errors.dueTime ? (
            <FieldError id="qc-task-time-error" message={errors.dueTime} />
          ) : (
            <p id="qc-task-time-help" className="sr-only">
              In {tz}.
            </p>
          )}
        </div>
        <button
          type="submit"
          disabled={pending}
          className={buttonClass('primary', 'col-span-2 sm:col-span-1')}
        >
          <Plus aria-hidden className="size-4" />
          {pending ? 'Adding…' : 'Add task'}
        </button>
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Quick due dates">
        {(
          [
            ['Today', today],
            ['Tomorrow', tomorrow],
          ] as const
        ).map(([label, value]) => (
          <button
            key={label}
            type="button"
            aria-pressed={dueDate === value}
            onClick={() => setDueDate(value)}
            className="min-h-11 rounded-lg px-3 text-sm text-accent hover:bg-accent-soft aria-pressed:bg-accent-soft aria-pressed:font-medium sm:min-h-8"
          >
            {label}
          </button>
        ))}
        {dueDate || dueTime ? (
          <button
            type="button"
            onClick={() => {
              setDueDate('')
              setDueTime('')
            }}
            className="min-h-11 rounded-lg px-3 text-sm text-ink-muted hover:bg-surface-muted sm:min-h-8"
          >
            No date
          </button>
        ) : null}
      </div>
    </form>
  )
}
