import Link from 'next/link'
import { Suspense } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { addLocalDays } from '@personal-home/core'
import { getJournalEntry, listJournalEntries, listJournalRecordings, purgeExpiredRecordings } from '@personal-home/db'
import { PageHeader } from '@/components/shell/app-shell'
import { Card, CardHeader } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { JournalDay } from '@/components/journal/journal-day'
import { JournalHistory } from '@/components/journal/journal-history'
import { PendingDrafts } from '@/components/notes/pending-drafts'
import { withOwnerTx } from '@/lib/server/session'
import { formatLocalDate, ownerToday } from '../_lib/data'

const navLink =
  'inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm text-accent hover:bg-surface-muted hover:text-accent-strong'

async function History({ current }: { current: string }) {
  const entries = await withOwnerTx((tx) => listJournalEntries(tx, { limit: 30 }))
  return (
    <Card aria-labelledby="journal-history-heading">
      <CardHeader title="Recent days" id="journal-history-heading" />
      {entries.length === 0 ? (
        <EmptyState title="No journal entries yet">Type or record something for today.</EmptyState>
      ) : (
        <JournalHistory entries={entries} current={current} />
      )}
    </Card>
  )
}

/** One day's journal page. `date` null = today in the owner's timezone. */
export async function JournalView({ date }: { date: string | null }) {
  const data = await withOwnerTx(async (tx) => {
    const now = new Date()
    const { timezone, today } = await ownerToday(tx, now)
    const localDate = date ?? today
    // Retention also runs here, so expired recordings are deleted even if the purge job is not
    // scheduled yet (RLS allows the owner to delete their own rows).
    await purgeExpiredRecordings(tx, now)
    const entry = await getJournalEntry(tx, localDate)
    const recordings = await listJournalRecordings(tx, { localDate, now })
    return { timezone, today, localDate, entry, recordings }
  })
  const { timezone, today, localDate, entry, recordings } = data
  const prev = addLocalDays(localDate, -1)
  const next = addLocalDays(localDate, 1)

  return (
    <>
      <PageHeader
        title="Journal"
        subtitle={
          <span data-testid="journal-date">
            {formatLocalDate(localDate)}
            {localDate === today ? ' · today' : ''}
          </span>
        }
        actions={
          <nav aria-label="Journal days" className="flex items-center gap-1">
            <Link href={`/capture/journal/${prev}`} className={navLink}>
              <ChevronLeft aria-hidden className="size-4" />
              Previous day
            </Link>
            {localDate !== today ? (
              <Link href="/capture/journal" className={navLink}>
                Today
              </Link>
            ) : null}
            {localDate < today ? (
              <Link href={`/capture/journal/${next}`} className={navLink}>
                Next day
                <ChevronRight aria-hidden className="size-4" />
              </Link>
            ) : null}
          </nav>
        }
      />
      <PendingDrafts />
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_18rem]">
        <Card>
          {/* Keyed by date: switching days never carries text from one day into another. */}
          <JournalDay
            key={localDate}
            localDate={localDate}
            entry={entry}
            recordings={recordings}
            timeZone={timezone}
          />
        </Card>
        <Suspense
          fallback={
            <Card aria-busy="true">
              <CardHeader title="Recent days" />
            </Card>
          }
        >
          <History current={localDate} />
        </Suspense>
      </div>
    </>
  )
}
