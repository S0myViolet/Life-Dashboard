'use client'

import { PERSON_DATE_LIMITS } from '@personal-home/core'
import { FieldError, fieldAria } from '@/components/learning/form-kit'
import type { FormActionState } from '@/components/learning/form-state'
import {
  fieldsetLegendClass,
  hintClass,
  inputClass,
  selectClass,
} from '@/components/learning/form-styles'
import { monthName } from '@/components/learning/format'

const DAYS = Array.from({ length: 31 }, (_, i) => i + 1)
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1)

/**
 * Month + day (+ optional year) inputs. Field names are `${prefix}Month` etc. (or
 * `month`, `day`, `year` without a prefix). 29 February is always selectable; with a
 * year it must be a leap year (checked on save).
 */
export function DateFields({
  idPrefix,
  prefix = '',
  legend,
  state,
  required = false,
}: {
  idPrefix: string
  prefix?: string
  legend: React.ReactNode
  state: FormActionState
  required?: boolean
}) {
  const name = (n: string) => (prefix ? `${prefix}${n[0]!.toUpperCase()}${n.slice(1)}` : n)
  const id = (n: string) => `${idPrefix}-${n}`
  return (
    <fieldset>
      <legend className={fieldsetLegendClass}>{legend}</legend>
      <div className="mt-1 grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.1fr)] gap-2">
        <div>
          <label htmlFor={id('month')} className="sr-only">
            Month
          </label>
          <select
            id={id('month')}
            name={name('month')}
            defaultValue=""
            required={required}
            className={selectClass}
            {...fieldAria(state, id('month'), name('month'))}
          >
            <option value="">Month</option>
            {MONTHS.map((m) => (
              <option key={m} value={m}>
                {monthName(m)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id('day')} className="sr-only">
            Day
          </label>
          <select
            id={id('day')}
            name={name('day')}
            defaultValue=""
            required={required}
            className={selectClass}
            {...fieldAria(state, id('day'), name('day'))}
          >
            <option value="">Day</option>
            {DAYS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id('year')} className="sr-only">
            Year (optional)
          </label>
          <input
            id={id('year')}
            name={name('year')}
            type="number"
            inputMode="numeric"
            min={PERSON_DATE_LIMITS.yearMin}
            max={PERSON_DATE_LIMITS.yearMax}
            step={1}
            placeholder="Year"
            className={inputClass}
            {...fieldAria(state, id('year'), name('year'), id('year-hint'))}
          />
        </div>
      </div>
      <FieldError state={state} id={id('month')} name={name('month')} />
      <FieldError state={state} id={id('day')} name={name('day')} />
      <FieldError state={state} id={id('year')} name={name('year')} />
      <p id={id('year-hint')} className={hintClass}>
        Year is optional. 29 February shows on 28 February in other years.
      </p>
    </fieldset>
  )
}
