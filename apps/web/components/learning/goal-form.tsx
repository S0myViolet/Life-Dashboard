'use client'

import { useId, useState } from 'react'
import {
  LEARNING_GOAL_LIMITS,
  LEARNING_GOAL_STATUSES,
  LEARNING_GOAL_STATUS_LABELS,
  type LearningGoalStatus,
} from '@personal-home/core'
import { createGoalAction, updateGoalAction } from '@/app/(app)/learning/actions'
import { FieldError, FormMessage, SubmitButton, fieldAria, useFormAction } from './form-kit'
import {
  fieldsetLegendClass,
  hintClass,
  inputClass,
  labelClass,
  selectClass,
  textareaClass,
} from './form-styles'

export interface GoalFormValues {
  id: string
  title: string
  details: string | null
  targetDate: string | null
  status: LearningGoalStatus
  habitId: string | null
  bookId: string | null
  dailyMinutes: number | null
}

const WEEKDAYS = [
  { value: 1, short: 'Mon', long: 'Monday' },
  { value: 2, short: 'Tue', long: 'Tuesday' },
  { value: 3, short: 'Wed', long: 'Wednesday' },
  { value: 4, short: 'Thu', long: 'Thursday' },
  { value: 5, short: 'Fri', long: 'Friday' },
  { value: 6, short: 'Sat', long: 'Saturday' },
  { value: 7, short: 'Sun', long: 'Sunday' },
]

/**
 * Add or edit a learning goal. A goal can have a target date, a linked book ("finish
 * by"), a daily minutes target for reading, and a practice habit — an existing habit or
 * a new one created here.
 */
export function GoalForm({
  goal,
  books,
  habits,
}: {
  goal?: GoalFormValues
  books: { id: string; title: string }[]
  habits: { id: string; title: string }[]
}) {
  const action = goal ? updateGoalAction.bind(null, goal.id) : createGoalAction
  const [habitChoice, setHabitChoice] = useState(goal?.habitId ?? '')
  const { state, pending, formProps } = useFormAction(action, {
    // After a save the choice must match what was stored: a "New habit…" choice now
    // points at the habit just created, so saving again cannot create a second one.
    onSaved: (saved) => setHabitChoice(goal ? (saved.values?.habitId ?? '') : ''),
  })
  const uid = useId()
  const id = (name: string) => `goal-${uid}-${name}`
  const linkedHabitMissing = goal?.habitId && !habits.some((h) => h.id === goal.habitId)

  return (
    <form {...formProps} className="space-y-3" aria-label={goal ? 'Edit goal' : 'Add a goal'}>
      <div>
        <label htmlFor={id('title')} className={labelClass}>
          Goal
        </label>
        <input
          id={id('title')}
          name="title"
          required
          maxLength={LEARNING_GOAL_LIMITS.titleMax}
          defaultValue={goal?.title}
          placeholder="e.g. Read 20 books this year"
          autoComplete="off"
          className={inputClass}
          {...fieldAria(state, id('title'), 'title')}
        />
        <FieldError state={state} id={id('title')} name="title" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id('targetDate')} className={labelClass}>
            Target date <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <input
            id={id('targetDate')}
            name="targetDate"
            type="date"
            defaultValue={goal?.targetDate ?? ''}
            className={inputClass}
            {...fieldAria(state, id('targetDate'), 'targetDate')}
          />
          <FieldError state={state} id={id('targetDate')} name="targetDate" />
        </div>
        <div>
          <label htmlFor={id('bookId')} className={labelClass}>
            Book <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <select
            id={id('bookId')}
            name="bookId"
            defaultValue={goal?.bookId ?? ''}
            className={selectClass}
            {...fieldAria(state, id('bookId'), 'bookId', id('bookId-hint'))}
          >
            <option value="">No book</option>
            {books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title}
              </option>
            ))}
          </select>
          <FieldError state={state} id={id('bookId')} name="bookId" />
          <p id={id('bookId-hint')} className={hintClass}>
            With a target date, shows the pace needed to finish.
          </p>
        </div>
        <div>
          <label htmlFor={id('dailyMinutes')} className={labelClass}>
            Reading minutes a day <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <input
            id={id('dailyMinutes')}
            name="dailyMinutes"
            type="number"
            inputMode="numeric"
            min={LEARNING_GOAL_LIMITS.dailyMinutesMin}
            max={LEARNING_GOAL_LIMITS.dailyMinutesMax}
            step={1}
            defaultValue={goal?.dailyMinutes ?? ''}
            placeholder="e.g. 30"
            className={inputClass}
            {...fieldAria(state, id('dailyMinutes'), 'dailyMinutes', id('dailyMinutes-hint'))}
          />
          <FieldError state={state} id={id('dailyMinutes')} name="dailyMinutes" />
          <p id={id('dailyMinutes-hint')} className={hintClass}>
            Compared with the minutes in today&rsquo;s reading logs.
          </p>
        </div>
        <div>
          <label htmlFor={id('habitId')} className={labelClass}>
            Practice habit <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <select
            id={id('habitId')}
            name="habitId"
            value={habitChoice}
            onChange={(e) => setHabitChoice(e.target.value)}
            className={selectClass}
            {...fieldAria(state, id('habitId'), 'habitId')}
          >
            <option value="">No habit</option>
            {linkedHabitMissing ? (
              <option value={goal.habitId ?? ''}>Current habit (archived)</option>
            ) : null}
            {habits.map((h) => (
              <option key={h.id} value={h.id}>
                {h.title}
              </option>
            ))}
            <option value="new">New habit…</option>
          </select>
          <FieldError state={state} id={id('habitId')} name="habitId" />
        </div>
      </div>

      {habitChoice === 'new' ? (
        <div className="space-y-3 rounded-xl border border-line bg-surface-muted/60 p-3">
          <div>
            <label htmlFor={id('newHabitTitle')} className={labelClass}>
              Habit name
            </label>
            <input
              id={id('newHabitTitle')}
              name="newHabitTitle"
              maxLength={LEARNING_GOAL_LIMITS.habitTitleMax}
              placeholder="e.g. Read 30 minutes"
              autoComplete="off"
              className={inputClass}
              {...fieldAria(state, id('newHabitTitle'), 'newHabitTitle', id('newHabitTitle-hint'))}
            />
            <FieldError state={state} id={id('newHabitTitle')} name="newHabitTitle" />
            <p id={id('newHabitTitle-hint')} className={hintClass}>
              Leave blank to use the goal&rsquo;s name. Tick it off with your other habits.
            </p>
          </div>
          <fieldset
            aria-describedby={fieldAria(state, id('days'), 'newHabitWeekdays')['aria-describedby']}
          >
            <legend className={fieldsetLegendClass}>On these days</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {WEEKDAYS.map((d) => (
                <label
                  key={d.value}
                  className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-line-strong bg-surface px-2 text-sm text-ink has-[:checked]:border-accent has-[:checked]:bg-accent-soft sm:min-h-10"
                >
                  <input
                    type="checkbox"
                    name="newHabitWeekdays"
                    value={d.value}
                    defaultChecked
                    className="size-4 accent-[var(--color-accent)]"
                  />
                  <span aria-hidden>{d.short}</span>
                  <span className="sr-only">{d.long}</span>
                </label>
              ))}
            </div>
            <FieldError state={state} id={id('days')} name="newHabitWeekdays" />
          </fieldset>
        </div>
      ) : null}

      <div>
        <label htmlFor={id('details')} className={labelClass}>
          Notes <span className="font-normal text-ink-muted">(optional)</span>
        </label>
        <textarea
          id={id('details')}
          name="details"
          rows={2}
          maxLength={LEARNING_GOAL_LIMITS.detailsMax}
          defaultValue={goal?.details ?? ''}
          className={textareaClass}
          {...fieldAria(state, id('details'), 'details')}
        />
        <FieldError state={state} id={id('details')} name="details" />
      </div>

      {goal ? (
        <div className="sm:max-w-xs">
          <label htmlFor={id('status')} className={labelClass}>
            Status
          </label>
          <select
            id={id('status')}
            name="status"
            defaultValue={goal.status}
            className={selectClass}
          >
            {LEARNING_GOAL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {LEARNING_GOAL_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={pending}>{goal ? 'Save goal' : 'Add goal'}</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}
