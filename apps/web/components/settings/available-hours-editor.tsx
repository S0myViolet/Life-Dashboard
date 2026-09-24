'use client'

import { useActionState, useId, useMemo, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import {
  AVAILABLE_HOURS_MAX_SLOTS_PER_DAY,
  AVAILABLE_HOURS_WEEKDAYS,
  AVAILABLE_HOURS_WEEKDAY_LABELS,
  type AvailableHours,
  type AvailableHoursWeekday,
} from '@personal-home/core'
import { Button, buttonClass } from '@/components/ui/button'
import { IDLE_STATE } from '@/lib/settings/action-state'
import { saveAvailableHoursAction } from '@/lib/settings/actions'
import { FormMessage } from './settings-list'

interface Row {
  key: number
  weekday: AvailableHoursWeekday
  start: string
  end: string
}

const inputClass =
  'block min-h-11 w-full min-w-0 rounded-xl border border-line-strong bg-surface px-3 text-[15px] text-ink aria-[invalid=true]:border-danger'

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number)
  const total = Math.min((h ?? 0) * 60 + (m ?? 0) + minutes, 23 * 60 + 59)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** A sensible default for a new range: 09:00–17:00, or the hour after the day's last range. */
function nextRange(existing: Row[]): { start: string; end: string } {
  const last = existing[existing.length - 1]
  if (!last) return { start: '09:00', end: '17:00' }
  return { start: last.end, end: addMinutes(last.end, 60) }
}

/**
 * Edit optional available hours: per ISO weekday, zero or more local time
 * ranges. The server validates (HH:MM, start before end, no overlaps per day)
 * and its messages are shown next to the range they refer to.
 */
export function AvailableHoursEditor({ initial }: { initial: AvailableHours | null }) {
  const [rows, setRows] = useState<Row[]>(() =>
    (initial ?? []).map((slot, index) => ({ ...slot, key: index })),
  )
  // Keys for rows added later; only read in event handlers.
  const nextKey = useRef(initial?.length ?? 0)
  const newKey = () => nextKey.current++
  const [state, action, pending] = useActionState(saveAvailableHoursAction, IDLE_STATE)
  const [submitted, setSubmitted] = useState<string | null>(null)
  const formId = useId()

  // Submission order: weekday, then the order ranges were added.
  const ordered = useMemo(
    () =>
      AVAILABLE_HOURS_WEEKDAYS.flatMap((weekday) => rows.filter((r) => r.weekday === weekday)),
    [rows],
  )
  const payload = JSON.stringify(
    ordered.map(({ weekday, start, end }) => ({ weekday, start, end })),
  )
  // Field errors refer to the submitted order; hide them once the ranges change.
  const errors =
    state.status === 'error' && submitted === payload ? (state.fieldErrors ?? {}) : {}
  const errorFor = (row: Row) => errors[String(ordered.indexOf(row))]

  const update = (key: number, patch: Partial<Row>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const remove = (key: number) => setRows((current) => current.filter((r) => r.key !== key))
  const add = (weekday: AvailableHoursWeekday) => {
    const range = nextRange(rows.filter((r) => r.weekday === weekday))
    setRows([...rows, { key: newKey(), weekday, ...range }])
  }
  const copyMondayToWeekdays = () => {
    const monday = rows.filter((r) => r.weekday === 1)
    const weekend = rows.filter((r) => r.weekday > 5)
    const copies = ([2, 3, 4, 5] as const).flatMap((weekday) =>
      monday.map((r) => ({ key: newKey(), weekday, start: r.start, end: r.end })),
    )
    setRows([...monday, ...copies, ...weekend])
  }

  const submit = (formData: FormData) => {
    setSubmitted(String(formData.get('hours') ?? ''))
    action(formData)
  }

  const hasMonday = rows.some((r) => r.weekday === 1)

  return (
    <form action={submit} id={formId} className="space-y-4">
      <input type="hidden" name="hours" value={payload} />
      <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line bg-surface">
        {AVAILABLE_HOURS_WEEKDAYS.map((weekday) => {
          const label = AVAILABLE_HOURS_WEEKDAY_LABELS[weekday]
          const dayRows = rows.filter((r) => r.weekday === weekday)
          return (
            <li key={weekday} className="p-3 sm:p-4">
              <fieldset>
                <legend className="text-[15px] font-medium text-ink">
                  {label}
                  {dayRows.length === 0 ? (
                    <span className="ml-2 text-sm font-normal text-ink-faint">No hours</span>
                  ) : null}
                </legend>
                <div className="mt-2 space-y-2">
                  {dayRows.map((row, i) => {
                    const error = errorFor(row)
                    const errorId = `${formId}-err-${row.key}`
                    const n = dayRows.length > 1 ? ` ${i + 1}` : ''
                    return (
                      <div key={row.key}>
                        <div className="flex items-end gap-2">
                          <label className="min-w-0 flex-1 text-xs text-ink-muted">
                            From
                            <input
                              type="time"
                              required
                              value={row.start}
                              aria-label={`${label}${n} from`}
                              aria-invalid={error ? true : undefined}
                              aria-describedby={error ? errorId : undefined}
                              onChange={(e) => update(row.key, { start: e.target.value.slice(0, 5) })}
                              className={inputClass}
                            />
                          </label>
                          <label className="min-w-0 flex-1 text-xs text-ink-muted">
                            To
                            <input
                              type="time"
                              required
                              value={row.end}
                              aria-label={`${label}${n} to`}
                              aria-invalid={error ? true : undefined}
                              aria-describedby={error ? errorId : undefined}
                              onChange={(e) => update(row.key, { end: e.target.value.slice(0, 5) })}
                              className={inputClass}
                            />
                          </label>
                          <button
                            type="button"
                            onClick={() => remove(row.key)}
                            className={buttonClass('ghost', 'shrink-0 px-3')}
                            aria-label={`Remove ${label}${n} ${row.start}–${row.end}`}
                          >
                            <Trash2 aria-hidden className="size-4" />
                          </button>
                        </div>
                        {error ? (
                          <p id={errorId} className="mt-1 text-sm text-danger">
                            {error}
                          </p>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
                {dayRows.length < AVAILABLE_HOURS_MAX_SLOTS_PER_DAY ? (
                  <button
                    type="button"
                    onClick={() => add(weekday)}
                    className="mt-2 inline-flex min-h-11 items-center gap-1 rounded-md text-sm font-medium text-accent hover:text-accent-strong sm:min-h-8"
                    aria-label={`Add hours on ${label}`}
                  >
                    <Plus aria-hidden className="size-4" />
                    Add hours
                  </button>
                ) : null}
              </fieldset>
            </li>
          )
        })}
      </ul>
      {errors.form ? <p className="text-sm text-danger">{errors.form}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Save hours'}
        </Button>
        {hasMonday ? (
          <Button type="button" onClick={copyMondayToWeekdays}>
            Copy Monday to Tue–Fri
          </Button>
        ) : null}
        {rows.length > 0 ? (
          <Button type="button" variant="ghost" onClick={() => setRows([])}>
            Clear all
          </Button>
        ) : null}
      </div>
      <FormMessage state={state.status === 'error' && submitted !== payload ? IDLE_STATE : state} />
    </form>
  )
}
