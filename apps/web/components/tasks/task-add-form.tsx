'use client'

/**
 * Inline "add a task": the title and the common fields up front, the rest
 * under "More options". After a save the form clears and keeps focus on the
 * title for quick entry; after an error it keeps what was typed.
 */
import { useActionState, useEffect, useRef } from 'react'
import { Plus } from 'lucide-react'
import { buttonClass } from '@/components/ui/button'
import { createTaskAction } from '@/lib/tasks/actions'
import { TASKS_FORM_IDLE, type TasksFormState } from '@/lib/tasks/forms'
import { TaskFields } from './task-fields'
import { FieldError, FormStatus, inputClass } from './ui'

export function TaskAddForm({
  projects,
  today,
  tomorrow,
  tz,
}: {
  projects: { id: string; name: string }[]
  today: string
  tomorrow: string
  tz: string
}) {
  const [state, action, pending] = useActionState(createTaskAction, TASKS_FORM_IDLE)
  const values = state.status === 'error' ? state.values : {}
  const errors = state.status === 'error' ? state.fieldErrors : {}
  const formKey = state.status === 'idle' ? 'initial' : state.stamp

  return (
    <section
      aria-labelledby="add-task-heading"
      className="space-y-3 rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5"
    >
      <h2 id="add-task-heading" className="text-[15px] font-semibold tracking-tight text-ink">
        Add a task
      </h2>
      <AddFormBody
        key={formKey}
        state={state}
        action={action}
        pending={pending}
        values={values}
        errors={errors}
        projects={projects}
        today={today}
        tomorrow={tomorrow}
        tz={tz}
      />
      {/* Outside the keyed form so screen readers announce each new result. */}
      <div aria-live="polite">
        <FormStatus state={state} />
      </div>
    </section>
  )
}

function AddFormBody({
  state,
  action,
  pending,
  values,
  errors,
  projects,
  today,
  tomorrow,
  tz,
}: {
  state: TasksFormState
  action: (formData: FormData) => void
  pending: boolean
  values: Record<string, string>
  errors: Record<string, string>
  projects: { id: string; name: string }[]
  today: string
  tomorrow: string
  tz: string
}) {
  const formRef = useRef<HTMLFormElement>(null)
  // Remounted per response: focus the title after a save, the first bad field after an error.
  useEffect(() => {
    const form = formRef.current
    if (!form || state.status === 'idle') return
    if (state.status === 'saved') {
      form.querySelector<HTMLInputElement>('input[name="title"]')?.focus()
    } else {
      const bad = form.querySelector<HTMLElement>('[aria-invalid="true"]')
      bad?.focus()
    }
  }, [state])

  return (
    <form
      ref={formRef}
      action={action}
      noValidate
      aria-labelledby="add-task-heading"
      className="space-y-3"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor="add-title" className="sr-only">
            Task title
          </label>
          <input
            id="add-title"
            name="title"
            required
            maxLength={300}
            autoComplete="off"
            placeholder="What needs doing?"
            defaultValue={values.title ?? ''}
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={errors.title ? 'add-title-error' : undefined}
            className={`${inputClass} mt-0`}
          />
          <FieldError id="add-title-error" message={errors.title} />
        </div>
        <button
          type="submit"
          disabled={pending}
          className={buttonClass('primary', 'shrink-0 px-3 sm:px-4')}
        >
          <Plus aria-hidden className="size-4" />
          {pending ? 'Adding…' : 'Add task'}
        </button>
      </div>
      <TaskFields
        prefix="add"
        mode="create"
        defaults={values}
        errors={errors}
        projects={projects}
        today={today}
        tomorrow={tomorrow}
        tz={tz}
        compact
      />
    </form>
  )
}
