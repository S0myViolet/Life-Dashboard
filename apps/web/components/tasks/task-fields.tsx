'use client'

/**
 * The task fields shared by the inline add form and the edit sheet: due date
 * (with Today/Tomorrow shortcuts), optional time, priority, duration, project,
 * reminder, splittable and notes. Input names match the server's field names.
 */
import { useState } from 'react'
import {
  TASK_DURATION_MAX_MINUTES,
  TASK_DURATION_MIN_MINUTES,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_REMINDER_CHOICE_LABELS,
  type TaskReminderChoice,
} from '@personal-home/core'
import { FieldError, fieldIds, helpClass, inputClass, labelClass } from './ui'

export interface TaskFieldsProps {
  /** Prefix for element ids (unique per form on the page). */
  prefix: string
  mode: 'create' | 'update'
  defaults: Record<string, string>
  errors: Record<string, string>
  projects: { id: string; name: string }[]
  today: string
  tomorrow: string
  tz: string
  /** Edit form: the task's current reminder, offered as "keep". */
  currentReminderLabel?: string | null
  /** Add form: tuck the less common fields into "More options". */
  compact?: boolean
  /**
   * False for a closed task: no reminder field is posted, so its reminders are
   * kept as they are (they come back if the task is reopened).
   */
  showReminder?: boolean
}

const RELATIVE: TaskReminderChoice[] = ['at_due', '15m', '1h', '1d']

function describedBy(errorId: string, error: string | undefined, helpId?: string) {
  return error ? errorId : helpId
}

export function TaskFields({
  prefix,
  mode,
  defaults,
  errors,
  projects,
  today,
  tomorrow,
  tz,
  currentReminderLabel,
  compact,
  showReminder = true,
}: TaskFieldsProps) {
  const [dueDate, setDueDate] = useState(defaults.dueDate ?? '')
  const [dueTime, setDueTime] = useState(defaults.dueTime ?? '')
  const initialChoice =
    (defaults.reminder as TaskReminderChoice | undefined) ??
    (mode === 'update' && currentReminderLabel ? 'keep' : 'none')
  const [reminder, setReminder] = useState<TaskReminderChoice>(initialChoice)
  const hasTime = dueDate !== '' && dueTime !== ''

  const f = (name: string) => fieldIds(prefix, name)
  const due = f('dueDate')
  const time = f('dueTime')
  const priority = f('priority')
  const duration = f('durationMinutes')
  const project = f('projectId')
  const rem = f('reminder')
  const remDate = f('reminderDate')
  const remTime = f('reminderTime')
  const split = f('splittable')
  const details = f('details')

  const primary = (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
      <div className="col-span-2 sm:col-span-1">
        <label htmlFor={due.id} className={labelClass}>
          Due date
        </label>
        <input
          id={due.id}
          name="dueDate"
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          aria-invalid={errors.dueDate ? true : undefined}
          aria-describedby={describedBy(due.errorId, errors.dueDate)}
          className={inputClass}
        />
        <FieldError id={due.errorId} message={errors.dueDate} />
        <div className="mt-1 flex flex-wrap gap-1" role="group" aria-label="Quick due dates">
          {[
            ['Today', today],
            ['Tomorrow', tomorrow],
          ].map(([label, value]) => (
            <button
              key={label}
              type="button"
              aria-pressed={dueDate === value}
              onClick={() => setDueDate(value!)}
              className="min-h-11 rounded-lg px-2 text-sm text-accent hover:bg-accent-soft aria-pressed:bg-accent-soft aria-pressed:font-medium sm:min-h-8"
            >
              {label}
            </button>
          ))}
          {dueDate ? (
            <button
              type="button"
              onClick={() => {
                setDueDate('')
                setDueTime('')
              }}
              className="min-h-11 rounded-lg px-2 text-sm text-ink-muted hover:bg-surface-muted sm:min-h-8"
            >
              No date
            </button>
          ) : null}
        </div>
      </div>
      <div>
        <label htmlFor={time.id} className={labelClass}>
          Time <span className="font-normal text-ink-faint">(optional)</span>
        </label>
        <input
          id={time.id}
          name="dueTime"
          type="time"
          value={dueTime}
          onChange={(e) => setDueTime(e.target.value)}
          disabled={dueDate === ''}
          aria-invalid={errors.dueTime ? true : undefined}
          aria-describedby={describedBy(time.errorId, errors.dueTime, `${time.id}-help`)}
          className={`${inputClass} disabled:opacity-50`}
        />
        {errors.dueTime ? (
          <FieldError id={time.errorId} message={errors.dueTime} />
        ) : (
          <p id={`${time.id}-help`} className="sr-only">
            In {tz}. Pick a due date first.
          </p>
        )}
      </div>
      <div>
        <label htmlFor={priority.id} className={labelClass}>
          Priority
        </label>
        <select
          id={priority.id}
          name="priority"
          defaultValue={defaults.priority ?? ''}
          aria-invalid={errors.priority ? true : undefined}
          aria-describedby={describedBy(priority.errorId, errors.priority)}
          className={inputClass}
        >
          <option value="">None</option>
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {TASK_PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
        <FieldError id={priority.errorId} message={errors.priority} />
      </div>
    </div>
  )

  const reminderOptions: TaskReminderChoice[] =
    mode === 'update' && currentReminderLabel
      ? ['keep', 'none', ...RELATIVE, 'custom']
      : ['none', ...RELATIVE, 'custom']

  const secondary = (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <label htmlFor={duration.id} className={labelClass}>
          Duration <span className="font-normal text-ink-faint">(minutes, optional)</span>
        </label>
        <input
          id={duration.id}
          name="durationMinutes"
          type="number"
          inputMode="numeric"
          min={TASK_DURATION_MIN_MINUTES}
          max={TASK_DURATION_MAX_MINUTES}
          step={1}
          defaultValue={defaults.durationMinutes ?? ''}
          aria-invalid={errors.durationMinutes ? true : undefined}
          aria-describedby={describedBy(duration.errorId, errors.durationMinutes)}
          className={inputClass}
        />
        <FieldError id={duration.errorId} message={errors.durationMinutes} />
      </div>
      {projects.length > 0 ? (
        <div>
          <label htmlFor={project.id} className={labelClass}>
            Project
          </label>
          <select
            id={project.id}
            name="projectId"
            defaultValue={defaults.projectId ?? ''}
            aria-invalid={errors.projectId ? true : undefined}
            aria-describedby={describedBy(project.errorId, errors.projectId)}
            className={inputClass}
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <FieldError id={project.errorId} message={errors.projectId} />
        </div>
      ) : null}
      {showReminder ? (
        <div className="sm:col-span-2">
          <label htmlFor={rem.id} className={labelClass}>
            Reminder
          </label>
          <select
            id={rem.id}
            name="reminder"
            value={reminder}
            onChange={(e) => setReminder(e.target.value as TaskReminderChoice)}
            aria-invalid={errors.reminder ? true : undefined}
            aria-describedby={describedBy(rem.errorId, errors.reminder, `${rem.id}-help`)}
            className={inputClass}
          >
            {reminderOptions.map((c) => (
              <option key={c} value={c} disabled={RELATIVE.includes(c) && !hasTime}>
                {c === 'keep'
                  ? `Keep: ${currentReminderLabel}`
                  : c === 'none' && mode === 'update' && currentReminderLabel
                    ? 'Remove reminder'
                    : TASK_REMINDER_CHOICE_LABELS[c]}
              </option>
            ))}
          </select>
          {errors.reminder ? (
            <FieldError id={rem.errorId} message={errors.reminder} />
          ) : (
            <p id={`${rem.id}-help`} className={helpClass}>
              {hasTime
                ? 'Shown in the app when it is due.'
                : 'Add a due time to be reminded relative to it.'}
            </p>
          )}
          {reminder === 'custom' ? (
            <div className="mt-2 grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={remDate.id} className={labelClass}>
                  Reminder date
                </label>
                <input
                  id={remDate.id}
                  name="reminderDate"
                  type="date"
                  defaultValue={defaults.reminderDate || dueDate}
                  aria-invalid={errors.reminderDate ? true : undefined}
                  aria-describedby={describedBy(remDate.errorId, errors.reminderDate)}
                  className={inputClass}
                />
                <FieldError id={remDate.errorId} message={errors.reminderDate} />
              </div>
              <div>
                <label htmlFor={remTime.id} className={labelClass}>
                  Reminder time
                </label>
                <input
                  id={remTime.id}
                  name="reminderTime"
                  type="time"
                  defaultValue={defaults.reminderTime ?? ''}
                  aria-invalid={errors.reminderTime ? true : undefined}
                  aria-describedby={describedBy(remTime.errorId, errors.reminderTime)}
                  className={inputClass}
                />
                <FieldError id={remTime.errorId} message={errors.reminderTime} />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="sm:col-span-2">
        <label
          htmlFor={split.id}
          className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-ink"
        >
          <input
            id={split.id}
            name="splittable"
            type="checkbox"
            defaultChecked={defaults.splittable === 'on'}
            aria-describedby={`${split.id}-help`}
            className="size-5 accent-[var(--color-accent)]"
          />
          <span className="font-medium">Can be split across several sessions</span>
        </label>
        <p id={`${split.id}-help`} className="text-sm text-ink-muted">
          The daily plan only splits tasks marked like this.
        </p>
      </div>
      <div className="sm:col-span-2">
        <label htmlFor={details.id} className={labelClass}>
          Notes <span className="font-normal text-ink-faint">(optional)</span>
        </label>
        <textarea
          id={details.id}
          name="details"
          rows={3}
          maxLength={10_000}
          defaultValue={defaults.details ?? ''}
          aria-invalid={errors.details ? true : undefined}
          aria-describedby={describedBy(details.errorId, errors.details)}
          className={`${inputClass} py-2`}
        />
        <FieldError id={details.errorId} message={errors.details} />
      </div>
    </div>
  )

  if (!compact) {
    return (
      <div className="space-y-4">
        {primary}
        {secondary}
      </div>
    )
  }
  const secondaryHasContent = [
    'durationMinutes',
    'projectId',
    'reminder',
    'reminderDate',
    'reminderTime',
    'details',
  ].some((k) => errors[k] || (defaults[k] && defaults[k] !== 'none'))
  return (
    <div className="space-y-3">
      {primary}
      <details className="group" open={secondaryHasContent || undefined}>
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-lg px-1 text-sm font-medium text-accent hover:text-accent-strong">
          <span className="group-open:hidden">More options</span>
          <span className="hidden group-open:inline">Fewer options</span>
          <span className="sr-only">: duration, project, reminder, splitting and notes</span>
        </summary>
        <div className="mt-2">{secondary}</div>
      </details>
    </div>
  )
}
