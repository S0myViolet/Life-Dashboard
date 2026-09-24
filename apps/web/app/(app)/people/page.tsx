import { Suspense } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { PeopleSearchSchema } from '@personal-home/core'
import { listPeople, type PersonSummary } from '@personal-home/db'
import { PageHeader } from '@/components/shell/app-shell'
import { buttonClass } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Pill } from '@/components/ui/status-pill'
import { inputClass } from '@/components/learning/form-styles'
import { plural } from '@/components/learning/format'
import { ownerToday } from '@/components/learning/owner-today'
import { SectionSkeleton } from '@/components/learning/section-skeleton'
import { TimeZoneNotice } from '@/components/learning/time-zone-notice'
import { PeopleAttentionCard } from '@/components/people/attention-card'
import { occurrenceText } from '@/components/people/format'
import { PersonForm } from '@/components/people/person-form'
import { requireOwner, withOwnerTx } from '@/lib/server/session'

export const metadata = { title: 'People' }

function PersonRow({ person, today }: { person: PersonSummary; today: string }) {
  const next = person.dates[0]
  const c = person.catchUp
  return (
    <li className="py-2.5 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-medium text-ink">
            <Link
              href={`/people/${person.id}`}
              className="rounded-sm hover:text-accent-strong hover:underline"
            >
              {person.name}
            </Link>
          </h3>
          {person.relationship ? (
            <p className="text-sm text-ink-muted">{person.relationship}</p>
          ) : null}
          {next ? (
            <p className="text-xs text-ink-muted">
              {next.label}: {occurrenceText(next.label, next.next, today)}
            </p>
          ) : null}
        </div>
        {c.state === 'due' ? (
          <Pill tone="accent">Catch up today</Pill>
        ) : c.state === 'overdue' ? (
          <Pill tone="caution">Catch-up overdue</Pill>
        ) : null}
      </div>
    </li>
  )
}

async function PeopleList({ search }: { search: string }) {
  const { people, today } = await withOwnerTx(async (tx) => {
    const { today } = await ownerToday(tx)
    return { people: await listPeople(tx, { today, search }), today }
  })
  const title = search ? `Matching “${search}”` : 'Everyone'
  return (
    <Card aria-labelledby="people-list-title">
      <CardHeader
        id="people-list-title"
        title={title}
        meta={people.length ? plural(people.length, 'person', 'people') : undefined}
      />
      {people.length ? (
        <ul className="divide-y divide-line">
          {people.map((p) => (
            <PersonRow key={p.id} person={p} today={today} />
          ))}
        </ul>
      ) : search ? (
        <EmptyState title="No one matches">
          Nobody&rsquo;s name, relationship or notes contain &ldquo;{search}&rdquo;.
        </EmptyState>
      ) : (
        <EmptyState title="No people yet">
          Add the people you want to keep in touch with. Nothing is imported from your contacts.
        </EmptyState>
      )}
    </Card>
  )
}

async function AddPersonCard() {
  const { today } = await withOwnerTx((tx) => ownerToday(tx))
  return (
    <Card aria-labelledby="add-person-title">
      <CardHeader id="add-person-title" title="Add a person" />
      <PersonForm today={today} idPrefix="new-person" />
    </Card>
  )
}

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireOwner()
  const search = PeopleSearchSchema.parse((await searchParams).q)

  return (
    <>
      <PageHeader
        title="People"
        subtitle="People you keep in touch with, their important dates and catch-up reminders."
      />
      <Suspense fallback={null}>
        <TimeZoneNotice />
      </Suspense>
      <form role="search" action="/people" className="mb-4 flex gap-2">
        <label htmlFor="people-search" className="sr-only">
          Search people
        </label>
        <input
          id="people-search"
          type="search"
          name="q"
          defaultValue={search}
          placeholder="Search names, relationships and notes"
          maxLength={100}
          className={`${inputClass.replace('mt-1 ', '')} min-w-0 flex-1`}
        />
        <button type="submit" className={buttonClass('secondary', 'shrink-0')}>
          <Search aria-hidden className="size-4" />
          <span className="sr-only sm:not-sr-only">Search</span>
        </button>
        {search ? (
          <Link href="/people" className={buttonClass('ghost', 'shrink-0')}>
            Clear
          </Link>
        ) : null}
      </form>
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="min-w-0 space-y-4 lg:col-span-3">
          <Suspense key={search} fallback={<SectionSkeleton title="Everyone" />}>
            <PeopleList search={search} />
          </Suspense>
        </div>
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Suspense fallback={<SectionSkeleton title="Coming up" />}>
            <PeopleAttentionCard />
          </Suspense>
          <Suspense fallback={<SectionSkeleton title="Add a person" />}>
            <AddPersonCard />
          </Suspense>
        </div>
      </div>
    </>
  )
}
