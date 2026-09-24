'use client'

import { CATCH_UP_PRESETS, PERSON_LIMITS } from '@personal-home/core'
import { createPersonAction, updatePersonAction } from '@/app/(app)/people/actions'
import {
  FieldError,
  FormMessage,
  SubmitButton,
  fieldAria,
  useFormAction,
} from '@/components/learning/form-kit'
import {
  hintClass,
  inputClass,
  labelClass,
  selectClass,
  textareaClass,
} from '@/components/learning/form-styles'
import { DateFields } from './date-fields'

export interface PersonFormValues {
  id: string
  name: string
  relationship: string | null
  notes: string | null
  catchUpEveryDays: number | null
  lastCaughtUpOn: string | null
}

/** Add a person (with an optional birthday) or edit one. Manual entry only. */
export function PersonForm({
  person,
  today,
  idPrefix = 'person',
}: {
  person?: PersonFormValues
  today: string
  idPrefix?: string
}) {
  const action = person ? updatePersonAction.bind(null, person.id) : createPersonAction
  const { state, pending, formProps } = useFormAction(action)
  const id = (name: string) => `${idPrefix}-${name}`
  const custom =
    person?.catchUpEveryDays != null &&
    !CATCH_UP_PRESETS.some((p) => p.days === person.catchUpEveryDays)

  return (
    <form {...formProps} className="space-y-3" aria-label={person ? 'Edit person' : 'Add a person'}>
      <div>
        <label htmlFor={id('name')} className={labelClass}>
          Name
        </label>
        <input
          id={id('name')}
          name="name"
          required
          maxLength={PERSON_LIMITS.nameMax}
          defaultValue={person?.name}
          autoComplete="off"
          className={inputClass}
          {...fieldAria(state, id('name'), 'name')}
        />
        <FieldError state={state} id={id('name')} name="name" />
      </div>
      <div>
        <label htmlFor={id('relationship')} className={labelClass}>
          Relationship <span className="font-normal text-ink-muted">(optional)</span>
        </label>
        <input
          id={id('relationship')}
          name="relationship"
          maxLength={PERSON_LIMITS.relationshipMax}
          defaultValue={person?.relationship ?? ''}
          placeholder="e.g. sister, old friend, mentor"
          autoComplete="off"
          className={inputClass}
          {...fieldAria(state, id('relationship'), 'relationship')}
        />
        <FieldError state={state} id={id('relationship')} name="relationship" />
      </div>
      {person ? null : (
        <DateFields
          idPrefix={id('birthday')}
          prefix="birthday"
          legend={
            <>
              Birthday <span className="font-normal text-ink-muted">(optional)</span>
            </>
          }
          state={state}
        />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id('catchUpEveryDays')} className={labelClass}>
            Remind me to catch up
          </label>
          <select
            id={id('catchUpEveryDays')}
            name="catchUpEveryDays"
            defaultValue={person?.catchUpEveryDays ?? ''}
            className={selectClass}
            {...fieldAria(state, id('catchUpEveryDays'), 'catchUpEveryDays')}
          >
            <option value="">No reminder</option>
            {custom ? (
              <option value={person.catchUpEveryDays ?? ''}>
                Every {person.catchUpEveryDays} days
              </option>
            ) : null}
            {CATCH_UP_PRESETS.map((p) => (
              <option key={p.days} value={p.days}>
                {p.label}
              </option>
            ))}
          </select>
          <FieldError state={state} id={id('catchUpEveryDays')} name="catchUpEveryDays" />
        </div>
        {person ? (
          <div>
            <label htmlFor={id('lastCaughtUpOn')} className={labelClass}>
              Last caught up <span className="font-normal text-ink-muted">(optional)</span>
            </label>
            <input
              id={id('lastCaughtUpOn')}
              name="lastCaughtUpOn"
              type="date"
              max={today}
              defaultValue={person.lastCaughtUpOn ?? ''}
              className={inputClass}
              {...fieldAria(state, id('lastCaughtUpOn'), 'lastCaughtUpOn')}
            />
            <FieldError state={state} id={id('lastCaughtUpOn')} name="lastCaughtUpOn" />
          </div>
        ) : null}
      </div>
      <div>
        <label htmlFor={id('notes')} className={labelClass}>
          Notes <span className="font-normal text-ink-muted">(optional)</span>
        </label>
        <textarea
          id={id('notes')}
          name="notes"
          rows={person ? 6 : 3}
          maxLength={PERSON_LIMITS.notesMax}
          defaultValue={person?.notes ?? ''}
          className={textareaClass}
          {...fieldAria(state, id('notes'), 'notes', id('notes-hint'))}
        />
        <FieldError state={state} id={id('notes')} name="notes" />
        <p id={id('notes-hint')} className={hintClass}>
          Plain text, only for you.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={pending}>{person ? 'Save' : 'Add person'}</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}
