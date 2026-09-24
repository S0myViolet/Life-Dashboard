'use client'

/**
 * Create or edit a habit: a name, the weekdays it applies to (chips that are
 * real checkboxes) and, when editing, optional notes.
 */
import { useActionState, useEffect, useRef } from 'react'
import { HABIT_WEEKDAY_LABELS, HABIT_ISO_WEEKDAYS } from '@personal-home/core'
import { buttonClass } from '@/components/ui/button'
import { FieldError, FormStatus, inputClass, labelClass } from '@/components/tasks/ui'
import { createHabitAction, updateHabitAction } from '@/lib/tasks/actions'
import { TASKS_FORM_IDLE, type TasksFormState } from '@/lib/tasks/forms'

export interface HabitFormProps {
  mode: 'create' | 'update'
  prefix: string
  habit?: { id: string; title: string; details: string | null; weekdays: number[] }
  onSaved?: (message: string) => void
}

export function HabitForm({ mode, prefix, habit, onSaved }: HabitFormProps) {
  const [state, action, pending] = useActionState(
    mode === 'create' ? createHabitAction : updateHabitAction,
    TASKS_FORM_IDLE,
  )
  const savedStamp = state.status === 'saved' ? state.stamp : null
  const onSavedRef = useRef(onSaved)
  useEffect(() => {
    onSavedRef.current = onSaved
  })
  useEffect(() => {
    if (savedStamp && state.status === 'saved') onSavedRef.current?.(state.message)
    // Only when a new save arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedStamp])

  const key = state.status === 'idle' ? 'initial' : state.stamp
  return (
    <div className="space-y-2">
      <HabitFormBody
        key={key}
        mode={mode}
        prefix={prefix}
        habit={habit}
        state={state}
        action={action}
        pending={pending}
      />
      <div aria-live="polite">
        {mode === 'create' || state.status === 'error' ? <FormStatus state={state} /> : null}
      </div>
    </div>
  )
}

function HabitFormBody({
  mode,
  prefix,
  habit,
  state,
  action,
  pending,
}: {
  mode: 'create' | 'update'
  prefix: string
  habit?: HabitFormProps['habit']
  state: TasksFormState
  action: (formData: FormData) => void
  pending: boolean
}) {
  const errors = state.status === 'error' ? state.fieldErrors : {}
  const values = state.status === 'error' ? state.values : null
  const title = values ? (values.title ?? '') : (habit?.title ?? '')
  const details = values ? (values.details ?? '') : (habit?.details ?? '')
  const selected = new Set(
    values
      ? (values.weekdays ?? '').split(',').filter(Boolean).map(Number)
      : (habit?.weekdays ?? [1, 2, 3, 4, 5, 6, 7]),
  )
  const formRef = useRef<HTMLFormElement>(null)
  useEffect(() => {
    const form = formRef.current
    if (!form || state.status === 'idle') return
    if (state.status === 'error') {
      const bad = form.querySelector<HTMLElement>('[aria-invalid="true"]')
      ;(bad instanceof HTMLFieldSetElement ? bad.querySelector('input') : bad)?.focus()
    } else if (mode === 'create') form.querySelector<HTMLElement>('input[name="title"]')?.focus()
  }, [state, mode])

  return (
    <form ref={formRef} action={action} noValidate className="space-y-3">
      {habit ? <input type="hidden" name="habitId" value={habit.id} /> : null}
      <div>
        <label htmlFor={`${prefix}-title`} className={labelClass}>
          {mode === 'create' ? 'New habit' : 'Name'}
        </label>
        <input
          id={`${prefix}-title`}
          name="title"
          required
          maxLength={200}
          autoComplete="off"
          placeholder={mode === 'create' ? 'e.g. Stretch for 10 minutes' : undefined}
          defaultValue={title}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? `${prefix}-title-error` : undefined}
          className={inputClass}
        />
        <FieldError id={`${prefix}-title-error`} message={errors.title} />
      </div>
      <fieldset
        aria-invalid={errors.weekdays ? true : undefined}
        aria-describedby={errors.weekdays ? `${prefix}-weekdays-error` : undefined}
      >
        <legend className={labelClass}>Days</legend>
        <div className="mt-1 grid grid-cols-7 gap-0.5 sm:flex sm:gap-1">
          {HABIT_ISO_WEEKDAYS.map((d) => (
            <label key={d} className="relative block cursor-pointer">
              <input
                type="checkbox"
                name="weekdays"
                value={d}
                defaultChecked={selected.has(d)}
                className="peer absolute inset-0 size-full cursor-pointer opacity-0"
              />
              <span
                aria-hidden
                className="flex min-h-11 items-center justify-center rounded-lg border border-line-strong bg-surface px-1 text-sm text-ink-muted peer-checked:border-accent peer-checked:bg-accent peer-checked:font-medium peer-checked:text-white peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent sm:min-w-12"
              >
                {HABIT_WEEKDAY_LABELS[d].short}
              </span>
              <span className="sr-only">{HABIT_WEEKDAY_LABELS[d].long}</span>
            </label>
          ))}
        </div>
        <FieldError id={`${prefix}-weekdays-error`} message={errors.weekdays} />
      </fieldset>
      {mode === 'update' ? (
        <div>
          <label htmlFor={`${prefix}-details`} className={labelClass}>
            Notes <span className="font-normal text-ink-faint">(optional)</span>
          </label>
          <textarea
            id={`${prefix}-details`}
            name="details"
            rows={2}
            maxLength={2000}
            defaultValue={details}
            aria-invalid={errors.details ? true : undefined}
            aria-describedby={errors.details ? `${prefix}-details-error` : undefined}
            className={`${inputClass} py-2`}
          />
          <FieldError id={`${prefix}-details-error`} message={errors.details} />
        </div>
      ) : null}
      <button type="submit" disabled={pending} className={buttonClass('primary')}>
        {pending ? 'Saving…' : mode === 'create' ? 'Add habit' : 'Save changes'}
      </button>
    </form>
  )
}
