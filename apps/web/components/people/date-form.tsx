'use client'

import { useId } from 'react'
import { PERSON_DATE_LIMITS } from '@personal-home/core'
import { addPersonDateAction } from '@/app/(app)/people/actions'
import {
  FieldError,
  FormMessage,
  SubmitButton,
  fieldAria,
  useFormAction,
} from '@/components/learning/form-kit'
import { inputClass, labelClass, selectClass } from '@/components/learning/form-styles'
import { DateFields } from './date-fields'

const REMIND_OPTIONS = [
  { days: 0, label: 'On the day' },
  { days: 1, label: '1 day before' },
  { days: 3, label: '3 days before' },
  { days: 7, label: '1 week before' },
  { days: 14, label: '2 weeks before' },
  { days: 30, label: '30 days before' },
]

/** Add an important date (birthday, anniversary, …) to a person. */
export function PersonDateForm({ personId }: { personId: string }) {
  const { state, pending, formProps } = useFormAction(addPersonDateAction.bind(null, personId))
  const uid = useId()
  const id = (name: string) => `date-${uid}-${name}`
  const listId = id('labels')

  return (
    <form {...formProps} className="space-y-3" aria-label="Add an important date">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id('label')} className={labelClass}>
            What is it?
          </label>
          <input
            id={id('label')}
            name="label"
            required
            maxLength={PERSON_DATE_LIMITS.labelMax}
            list={listId}
            placeholder="Birthday"
            autoComplete="off"
            className={inputClass}
            {...fieldAria(state, id('label'), 'label')}
          />
          <datalist id={listId}>
            <option value="Birthday" />
            <option value="Anniversary" />
            <option value="Name day" />
          </datalist>
          <FieldError state={state} id={id('label')} name="label" />
        </div>
        <div>
          <label htmlFor={id('remindDaysBefore')} className={labelClass}>
            Remind me
          </label>
          <select
            id={id('remindDaysBefore')}
            name="remindDaysBefore"
            defaultValue={PERSON_DATE_LIMITS.remindDaysBeforeDefault}
            className={selectClass}
          >
            {REMIND_OPTIONS.map((o) => (
              <option key={o.days} value={o.days}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <DateFields idPrefix={id('when')} legend="Date" state={state} required />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={pending}>Add date</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}
