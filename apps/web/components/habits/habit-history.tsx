/**
 * The 8-week history grid for one habit: a table (weeks × Monday–Sunday) whose
 * cells carry their date and state as text for screen readers. Missed days are
 * marked with a cross as well as colour.
 */
import { Check, X } from 'lucide-react'
import { HABIT_WEEKDAY_LABELS, HABIT_ISO_WEEKDAYS, type HabitDayState } from '@personal-home/core'
import type { HabitView } from '@/lib/tasks/view-types'

const CELL: Record<HabitDayState, string> = {
  done: 'bg-positive text-white',
  missed: 'border border-danger/40 bg-danger-soft text-danger',
  pending: 'border-2 border-accent bg-surface',
  rest: 'bg-surface-muted',
  before_start: 'border border-dashed border-line',
  inactive: 'border border-dashed border-line',
  future: 'border border-line/60',
}

export function HabitHistory({ habit }: { habit: HabitView }) {
  return (
    <div className="mt-3">
      <table className="w-full max-w-[22rem] table-fixed border-separate border-spacing-1 text-xs">
        <caption className="sr-only">
          Last {habit.weeks.length} weeks of “{habit.title}”, Monday to Sunday
        </caption>
        <thead>
          <tr>
            <th scope="col" className="w-14 text-left font-normal text-ink-faint">
              <span className="sr-only">Week</span>
            </th>
            {HABIT_ISO_WEEKDAYS.map((d) => (
              <th key={d} scope="col" className="font-normal text-ink-faint">
                <abbr title={HABIT_WEEKDAY_LABELS[d].long} className="no-underline">
                  {HABIT_WEEKDAY_LABELS[d].short.slice(0, 2)}
                </abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {habit.weeks.map((week, i) => (
            <tr key={week[0]!.date}>
              <th
                scope="row"
                className="whitespace-nowrap pr-1 text-left font-normal text-ink-faint"
              >
                <span aria-hidden>{habit.weekLabels[i]!.short}</span>
                <span className="sr-only">{habit.weekLabels[i]!.long}</span>
              </th>
              {week.map((cell) => (
                <td key={cell.date} className="p-0" data-date={cell.date} data-state={cell.state}>
                  <span
                    aria-hidden
                    className={`mx-auto flex aspect-square w-full max-w-8 items-center justify-center rounded-md ${CELL[cell.state]}`}
                  >
                    {cell.state === 'done' ? <Check className="size-3.5" strokeWidth={3} /> : null}
                    {cell.state === 'missed' ? <X className="size-3.5" strokeWidth={2.5} /> : null}
                  </span>
                  <span className="sr-only">{cell.label}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted" aria-label="Key">
        <LegendItem className={CELL.done} icon={<Check className="size-2.5" strokeWidth={3} />}>
          Done
        </LegendItem>
        <LegendItem className={CELL.missed} icon={<X className="size-2.5" strokeWidth={2.5} />}>
          Missed
        </LegendItem>
        <LegendItem className={CELL.pending}>Due today</LegendItem>
        <LegendItem className={CELL.rest}>Not scheduled</LegendItem>
      </ul>
    </div>
  )
}

function LegendItem({
  className,
  icon,
  children,
}: {
  className: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <li className="inline-flex items-center gap-1">
      <span
        aria-hidden
        className={`inline-flex size-3.5 items-center justify-center rounded ${className}`}
      >
        {icon}
      </span>
      {children}
    </li>
  )
}
