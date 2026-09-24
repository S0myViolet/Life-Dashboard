'use client'

import { useActionState, useEffect, useRef, useState, useTransition } from 'react'
import { buttonClass } from '@/components/ui/button'
import { deleteTaskAction, updateTaskAction } from '@/lib/tasks/actions'
import { TASKS_FORM_IDLE, type TasksFormState } from '@/lib/tasks/forms'
import type { TaskView } from '@/lib/tasks/view-types'
import { TaskFields } from './task-fields'
import { FieldError, FormStatus, Sheet, inputClass, labelClass } from './ui'

export interface TaskEditSheetProps {
  task: TaskView | null
  onClose: () => void
  onSaved: (message: string) => void
  onDeleted: (task: TaskView) => void
  onDeleteFailed: (message: string) => void
  projects: { id: string; name: string }[]
  today: string
  tomorrow: string
  tz: string
}

export function TaskEditSheet(props: TaskEditSheetProps) {
  const { task, onClose } = props
  return (
    <Sheet open={task !== null} onClose={onClose} title="Edit task" titleId="edit-task-heading">
      {task ? <TaskEditForm key={task.id} {...props} task={task} /> : null}
    </Sheet>
  )
}

function taskDefaults(task: TaskView): Record<string, string> {
  return {
    title: task.title,
    details: task.details ?? '',
    priority: task.priority ? String(task.priority) : '',
    dueDate: task.dueDate,
    dueTime: task.dueTime,
    durationMinutes: task.durationMinutes ? String(task.durationMinutes) : '',
    projectId: task.projectId ?? '',
    splittable: task.splittable ? 'on' : '',
    reminderDate: task.reminder?.date ?? '',
    reminderTime: task.reminder?.time ?? '',
  }
}

function TaskEditForm({
  task,
  onSaved,
  onDeleted,
  onDeleteFailed,
  projects,
  today,
  tomorrow,
  tz,
}: TaskEditSheetProps & { task: TaskView }) {
  const [state, action, pending] = useActionState(updateTaskAction, TASKS_FORM_IDLE)
  const savedStamp = state.status === 'saved' ? state.stamp : null
  const onSavedRef = useRef(onSaved)
  useEffect(() => {
    onSavedRef.current = onSaved
  })
  useEffect(() => {
    if (savedStamp && state.status === 'saved') {
      onSavedRef.current(state.notice ? `${state.message} ${state.notice}` : state.message)
    }
    // Only when a new save arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedStamp])

  const values = state.status === 'error' ? state.values : taskDefaults(task)
  const errors = state.status === 'error' ? state.fieldErrors : {}
  const bodyKey = state.status === 'error' ? state.stamp : 'initial'
  // Projects may include one that no longer exists: keep it selectable so saving does not drop it.
  const projectOptions =
    task.projectId && !projects.some((p) => p.id === task.projectId)
      ? [...projects, { id: task.projectId, name: task.projectName ?? 'Project unavailable' }]
      : projects

  return (
    <div className="space-y-4">
      <EditBody
        key={bodyKey}
        task={task}
        state={state}
        action={action}
        pending={pending}
        values={values}
        errors={errors}
        projects={projectOptions}
        today={today}
        tomorrow={tomorrow}
        tz={tz}
      />
      <div aria-live="polite">{state.status === 'error' ? <FormStatus state={state} /> : null}</div>
      <DeleteTask task={task} onDeleted={onDeleted} onDeleteFailed={onDeleteFailed} />
    </div>
  )
}

function EditBody({
  task,
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
  task: TaskView
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
  useEffect(() => {
    if (state.status === 'error') {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    }
  }, [state])

  return (
    <form ref={formRef} action={action} className="space-y-4">
      <input type="hidden" name="id" value={task.id} />
      <div>
        <label htmlFor="edit-title" className={labelClass}>
          Title
        </label>
        <input
          id="edit-title"
          name="title"
          required
          maxLength={300}
          autoComplete="off"
          defaultValue={values.title ?? ''}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? 'edit-title-error' : undefined}
          className={inputClass}
        />
        <FieldError id="edit-title-error" message={errors.title} />
      </div>
      <TaskFields
        prefix="edit"
        mode="update"
        defaults={values}
        errors={errors}
        projects={projects}
        today={today}
        tomorrow={tomorrow}
        tz={tz}
        currentReminderLabel={task.status === 'open' ? (task.reminder?.label ?? null) : null}
      />
      <p className="text-sm text-ink-muted">Dates and times are in {tz}.</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className={buttonClass('primary')}>
          {pending ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  )
}

function DeleteTask({
  task,
  onDeleted,
  onDeleteFailed,
}: {
  task: TaskView
  onDeleted: (task: TaskView) => void
  onDeleteFailed: (message: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [pending, startTransition] = useTransition()
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (confirming) confirmRef.current?.focus()
  }, [confirming])

  if (!confirming) {
    return (
      <div className="border-t border-line pt-3">
        <button type="button" className={buttonClass('ghost')} onClick={() => setConfirming(true)}>
          Delete task…
        </button>
      </div>
    )
  }
  return (
    <div
      role="group"
      aria-labelledby="delete-task-question"
      className="space-y-2 rounded-xl border border-danger/30 bg-danger-soft p-3"
    >
      <p id="delete-task-question" className="text-sm text-danger">
        Delete “{task.title}” and its reminders? This can’t be undone.
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          ref={confirmRef}
          type="button"
          disabled={pending}
          className={buttonClass('danger')}
          onClick={() =>
            startTransition(async () => {
              const r = await deleteTaskAction(task.id)
              if (r.ok) onDeleted(task)
              else onDeleteFailed(r.message)
            })
          }
        >
          {pending ? 'Deleting…' : 'Delete task'}
        </button>
        <button
          type="button"
          className={buttonClass('secondary')}
          onClick={() => setConfirming(false)}
        >
          Keep it
        </button>
      </div>
    </div>
  )
}
