import Link from 'next/link'
import { listPeopleAttention } from '@personal-home/db'
import { Card, CardHeader } from '@/components/ui/card'
import { Pill } from '@/components/ui/status-pill'
import { ownerToday } from '@/components/learning/owner-today'
import { formatLocalDate, plural, relativeDay } from '@/components/learning/format'
import { withOwnerTx } from '@/lib/server/session'

const HORIZON_DAYS = 30

/**
 * Coming up: catch-ups that are due and important dates in the next 30 days, from the
 * same listPeopleAttention() that Home uses.
 */
export async function PeopleAttentionCard() {
  const { attention, today } = await withOwnerTx(async (tx) => {
    const { today } = await ownerToday(tx)
    return { attention: await listPeopleAttention(tx, today, HORIZON_DAYS), today }
  })
  const { dueCatchUps, upcomingDates } = attention
  const empty = dueCatchUps.length === 0 && upcomingDates.length === 0

  return (
    <Card aria-labelledby="coming-up-title">
      <CardHeader id="coming-up-title" title="Coming up" meta={`Next ${HORIZON_DAYS} days`} />
      {empty ? (
        <p className="text-sm text-ink-muted">
          No catch-ups due and no important dates in the next {HORIZON_DAYS} days.
        </p>
      ) : (
        <div className="space-y-4">
          {dueCatchUps.length ? (
            <section aria-labelledby="due-catch-ups-title">
              <h3 id="due-catch-ups-title" className="text-sm font-medium text-ink-muted">
                Catch-ups due
              </h3>
              <ul className="mt-1 divide-y divide-line">
                {dueCatchUps.map((c) => (
                  <li key={c.personId} className="flex items-center justify-between gap-2 py-2">
                    <Link
                      href={`/people/${c.personId}`}
                      className="min-w-0 truncate rounded-sm text-sm text-ink hover:text-accent-strong hover:underline"
                    >
                      {c.personName}
                    </Link>
                    <Pill tone={c.daysOverdue > 0 ? 'caution' : 'accent'}>
                      {c.daysOverdue > 0 ? `${plural(c.daysOverdue, 'day')} overdue` : 'Due today'}
                    </Pill>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {upcomingDates.length ? (
            <section aria-labelledby="upcoming-dates-title">
              <h3 id="upcoming-dates-title" className="text-sm font-medium text-ink-muted">
                Important dates
              </h3>
              <ul className="mt-1 divide-y divide-line">
                {upcomingDates.map((d) => (
                  <li key={d.dateId} className="py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <Link
                        href={`/people/${d.personId}`}
                        className="min-w-0 truncate rounded-sm text-sm text-ink hover:text-accent-strong hover:underline"
                      >
                        {d.personName}
                      </Link>
                      <span
                        className={`shrink-0 text-xs ${d.reminderDue ? 'font-medium text-accent-strong' : 'text-ink-muted'}`}
                      >
                        {relativeDay(d.date, today)}
                      </span>
                    </div>
                    <p className="text-xs text-ink-muted">
                      {d.label} · {formatLocalDate(d.date, { today, weekday: true })}
                      {d.years != null && d.years > 0
                        ? /birthday/i.test(d.label)
                          ? ` · turns ${d.years}`
                          : ` · ${plural(d.years, 'year')}`
                        : ''}
                      {d.observedFromFeb29 ? ' · 29 Feb, marked on the 28th' : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </Card>
  )
}
