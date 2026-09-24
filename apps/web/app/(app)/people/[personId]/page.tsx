import { notFound } from 'next/navigation'
import { z } from 'zod'
import { getPerson } from '@personal-home/db'
import {
  deletePersonAction,
  deletePersonDateAction,
  markCaughtUpAction,
} from '@/app/(app)/people/actions'
import { PageHeader } from '@/components/shell/app-shell'
import { ButtonLink, buttonClass } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Pill } from '@/components/ui/status-pill'
import { ConfirmDeleteButton } from '@/components/learning/form-kit'
import { ownerToday } from '@/components/learning/owner-today'
import { PersonDateForm } from '@/components/people/date-form'
import {
  cadenceLabel,
  catchUpText,
  importantDateText,
  lastCaughtUpText,
  occurrenceText,
} from '@/components/people/format'
import { PersonForm } from '@/components/people/person-form'
import { requireOwner, withOwnerTx } from '@/lib/server/session'

export const metadata = { title: 'Person' }

export default async function PersonPage({ params }: { params: Promise<{ personId: string }> }) {
  await requireOwner()
  const { personId } = await params
  if (!z.uuid().safeParse(personId).success) notFound()
  const data = await withOwnerTx(async (tx) => {
    const { today } = await ownerToday(tx)
    return { person: await getPerson(tx, personId, today), today }
  })
  if (!data.person) notFound()
  const { person, today } = data
  const c = person.catchUp

  return (
    <>
      <PageHeader
        title={person.name}
        subtitle={person.relationship ?? undefined}
        actions={<ButtonLink href="/people">All people</ButtonLink>}
      />
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="min-w-0 space-y-4 lg:col-span-3">
          <Card aria-labelledby="catch-up-title">
            <CardHeader
              id="catch-up-title"
              title="Keeping in touch"
              meta={person.catchUpEveryDays ? cadenceLabel(person.catchUpEveryDays) : undefined}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-0.5">
                <p className="text-sm text-ink" data-testid="catch-up-status">
                  {catchUpText(c, today)}
                </p>
                <p className="text-sm text-ink-muted" data-testid="last-caught-up">
                  {lastCaughtUpText(person.lastCaughtUpOn, today)}
                </p>
              </div>
              {c.state === 'due' || c.state === 'overdue' ? (
                <Pill tone={c.state === 'overdue' ? 'caution' : 'accent'}>
                  {c.state === 'overdue' ? 'Overdue' : 'Due today'}
                </Pill>
              ) : null}
            </div>
            <form action={markCaughtUpAction.bind(null, person.id)} className="mt-3">
              <button
                type="submit"
                className={buttonClass(
                  c.state === 'due' || c.state === 'overdue' ? 'primary' : 'secondary',
                )}
              >
                Caught up today
              </button>
            </form>
          </Card>

          <Card aria-labelledby="dates-title">
            <CardHeader id="dates-title" title="Important dates" />
            {person.dates.length ? (
              <ul className="divide-y divide-line" data-testid="important-dates">
                {person.dates.map((d) => (
                  <li key={d.id} className="flex items-start justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">
                        {d.label} · {importantDateText(d)}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {occurrenceText(d.label, d.next, today)}
                      </p>
                    </div>
                    <form action={deletePersonDateAction.bind(null, d.id)}>
                      <button type="submit" className={buttonClass('ghost', 'shrink-0')}>
                        Remove<span className="sr-only"> {d.label}</span>
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">No important dates yet.</p>
            )}
            <details className="mt-3 rounded-xl border border-line bg-surface-muted/40 px-3 open:pb-3">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-accent hover:text-accent-strong">
                Add a date
              </summary>
              <div className="pt-1">
                <PersonDateForm personId={person.id} />
              </div>
            </details>
          </Card>

          <Card aria-labelledby="notes-title">
            <CardHeader id="notes-title" title="Notes" />
            {person.notes ? (
              <p
                className="whitespace-pre-wrap break-words text-sm text-ink"
                data-testid="person-notes"
              >
                {person.notes}
              </p>
            ) : (
              <EmptyState title="No notes yet">
                Add notes below: what they&rsquo;re up to, things to ask about next time.
              </EmptyState>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card aria-labelledby="edit-person-title">
            <CardHeader id="edit-person-title" title="Edit" />
            <PersonForm
              idPrefix="edit-person"
              today={today}
              person={{
                id: person.id,
                name: person.name,
                relationship: person.relationship,
                notes: person.notes,
                catchUpEveryDays: person.catchUpEveryDays,
                lastCaughtUpOn: person.lastCaughtUpOn,
              }}
            />
          </Card>
          <Card aria-labelledby="remove-person-title">
            <CardHeader id="remove-person-title" title="Remove" />
            <p className="mb-2 text-sm text-ink-muted">
              Deletes this person and their dates. Notes elsewhere that mention them stay.
            </p>
            <ConfirmDeleteButton
              action={deletePersonAction.bind(null, person.id)}
              label="Delete person"
              confirmLabel="Delete"
              question={`Delete ${person.name}?`}
            />
          </Card>
        </div>
      </div>
    </>
  )
}
