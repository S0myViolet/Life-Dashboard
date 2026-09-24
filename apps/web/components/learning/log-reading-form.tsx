'use client'

import { useId, useState } from 'react'
import { BOOK_LIMITS } from '@personal-home/core'
import { logReadingAction } from '@/app/(app)/learning/actions'
import { FieldError, FormMessage, SubmitButton, fieldAria, useFormAction } from './form-kit'
import {
  fieldsetLegendClass,
  hintClass,
  inputClass,
  labelClass,
  textareaClass,
} from './form-styles'

export type ReadingMeasure = 'page' | 'pages' | 'percent'

const MEASURE_LABELS: Record<ReadingMeasure, { option: string; field: string; hint: string }> = {
  page: { option: 'Page reached', field: 'Page you reached', hint: 'The page you are on now.' },
  pages: {
    option: 'Pages read',
    field: 'Number of pages read',
    hint: 'Pages read in this sitting.',
  },
  percent: { option: 'Percent', field: 'Percent through', hint: 'From your e-reader, 0–100.' },
}

/**
 * Log reading progress. One measure is enough: the page reached, pages read or a
 * percentage (minutes are optional on top, or on their own).
 */
export function LogReadingForm({
  bookId,
  bookTitle,
  defaultMeasure,
  totalPages,
  today,
}: {
  bookId: string
  bookTitle: string
  defaultMeasure: ReadingMeasure
  totalPages: number | null
  today: string
}) {
  const [measure, setMeasure] = useState<ReadingMeasure>(defaultMeasure)
  const { state, pending, formProps } = useFormAction(logReadingAction, {
    // Clearing the numbers also puts the radios back to their default: keep the label in step.
    onSaved: (_state, form) => {
      const checked = form.querySelector<HTMLInputElement>('input[name="measure"]:checked')
      const value = checked?.value
      if (value === 'page' || value === 'pages' || value === 'percent') setMeasure(value)
    },
  })
  const uid = useId()
  const id = (name: string) => `log-${uid}-${name}`
  const labels = MEASURE_LABELS[measure]
  const amountMax =
    measure === 'percent'
      ? 100
      : measure === 'page'
        ? (totalPages ?? BOOK_LIMITS.pageReachedMax)
        : BOOK_LIMITS.pagesReadMax

  return (
    <form {...formProps} className="space-y-3" aria-label={`Log progress for ${bookTitle}`}>
      <input type="hidden" name="bookId" value={bookId} />
      <fieldset>
        <legend className={fieldsetLegendClass}>How are you measuring?</legend>
        <div className="mt-1 flex flex-wrap gap-2">
          {(Object.keys(MEASURE_LABELS) as ReadingMeasure[]).map((m) => (
            <label
              key={m}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-line-strong bg-surface px-3 text-sm text-ink has-[:checked]:border-accent has-[:checked]:bg-accent-soft sm:min-h-10"
            >
              <input
                type="radio"
                name="measure"
                value={m}
                defaultChecked={m === defaultMeasure}
                onChange={() => setMeasure(m)}
                className="size-4 accent-[var(--color-accent)]"
              />
              {MEASURE_LABELS[m].option}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={id('amount')} className={labelClass}>
            {labels.field}
            {measure === 'page' && totalPages != null ? (
              <span className="font-normal text-ink-muted"> (of {totalPages})</span>
            ) : null}
          </label>
          <input
            id={id('amount')}
            name="amount"
            type="number"
            inputMode={measure === 'percent' ? 'decimal' : 'numeric'}
            min={measure === 'pages' ? 1 : 0}
            max={amountMax}
            step={measure === 'percent' ? 0.01 : 1}
            className={inputClass}
            {...fieldAria(state, id('amount'), 'amount', id('amount-hint'))}
          />
          <FieldError state={state} id={id('amount')} name="amount" />
          {state.status === 'error' && state.fieldErrors?.amount ? null : (
            <p id={id('amount-hint')} className={hintClass}>
              {labels.hint}
            </p>
          )}
        </div>
        <div>
          <label htmlFor={id('minutes')} className={labelClass}>
            Minutes <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <input
            id={id('minutes')}
            name="minutes"
            type="number"
            inputMode="numeric"
            min={1}
            max={BOOK_LIMITS.minutesMax}
            step={1}
            className={inputClass}
            {...fieldAria(state, id('minutes'), 'minutes')}
          />
          <FieldError state={state} id={id('minutes')} name="minutes" />
        </div>
      </div>
      <details className="group">
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm text-accent hover:text-accent-strong sm:min-h-0">
          Add a note or another date
        </summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor={id('note')} className={labelClass}>
              Note <span className="font-normal text-ink-muted">(optional)</span>
            </label>
            <textarea
              id={id('note')}
              name="note"
              rows={2}
              maxLength={BOOK_LIMITS.noteMax}
              className={textareaClass}
              {...fieldAria(state, id('note'), 'note')}
            />
            <FieldError state={state} id={id('note')} name="note" />
          </div>
          <div>
            <label htmlFor={id('localDate')} className={labelClass}>
              Date read
            </label>
            <input
              id={id('localDate')}
              name="localDate"
              type="date"
              max={today}
              defaultValue={today}
              className={inputClass}
              {...fieldAria(state, id('localDate'), 'localDate')}
            />
            <FieldError state={state} id={id('localDate')} name="localDate" />
          </div>
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={pending} pendingLabel="Logging…">
          Log progress
        </SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  )
}
