import Link from 'next/link'
import { Suspense } from 'react'
import { journalExcerpt } from '@personal-home/core'
import { getJournalEntry, listJournalRecordings, listNotes } from '@personal-home/db'
import { PageHeader } from '@/components/shell/app-shell'
import { ButtonLink } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Pill } from '@/components/ui/status-pill'
import { NewNoteButton } from '@/components/notes/new-note-button'
import { NoteList } from '@/components/notes/note-list'
import { CaptureSearch } from '@/components/notes/capture-search'
import { requireOwner, withOwnerTx } from '@/lib/server/session'
import { formatLocalDate, ownerTimezone, ownerToday } from './_lib/data'

export const metadata = { title: 'Capture' }

type SearchParams = Promise<{ view?: string | string[] }>

function Skeleton({ title }: { title: string }) {
  return (
    <Card aria-busy="true">
      <CardHeader title={title} />
      <div className="h-24 animate-pulse rounded-lg bg-surface-muted" />
    </Card>
  )
}

async function NotesSection({ view }: { view: 'recent' | 'pinned' }) {
  const { notes, timeZone } = await withOwnerTx(async (tx) => ({
    notes: await listNotes(tx, { view, limit: 50 }),
    timeZone: await ownerTimezone(tx),
  }))
  const tab = (v: 'recent' | 'pinned', text: string) => (
    <Link
      href={v === 'recent' ? '/capture' : '/capture?view=pinned'}
      aria-current={view === v ? 'page' : undefined}
      className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm text-ink-muted hover:bg-surface-muted aria-[current=page]:bg-accent-soft aria-[current=page]:font-medium aria-[current=page]:text-accent-strong sm:min-h-9"
    >
      {text}
    </Link>
  )
  return (
    <Card aria-labelledby="notes-heading">
      <CardHeader title="Notes" id="notes-heading" />
      <nav aria-label="Note lists" className="mb-2 flex gap-1">
        {tab('recent', 'Recent')}
        {tab('pinned', 'Pinned')}
      </nav>
      {notes.length === 0 ? (
        <EmptyState
          title={view === 'pinned' ? 'No pinned notes' : 'No notes yet'}
          action={view === 'pinned' ? undefined : <NewNoteButton variant="secondary" />}
        >
          {view === 'pinned' ? 'Pin a note to keep it at the top.' : 'Notes are freeform. Link them to a project, date, book or person if you like.'}
        </EmptyState>
      ) : (
        <NoteList notes={notes} timeZone={timeZone} />
      )}
    </Card>
  )
}

async function JournalTodayCard() {
  const data = await withOwnerTx(async (tx) => {
    const { today } = await ownerToday(tx)
    const entry = await getJournalEntry(tx, today)
    const recordings = await listJournalRecordings(tx, { localDate: today })
    return { today, entry, recordings }
  })
  const { today, entry, recordings } = data
  const excerpt = entry ? journalExcerpt(entry) : ''
  return (
    <Card aria-labelledby="journal-today-heading">
      <CardHeader title="Journal" id="journal-today-heading" href="/capture/journal" hrefLabel="Open" />
      <p className="text-sm font-medium text-ink">{formatLocalDate(today)}</p>
      {excerpt ? (
        <p className="mt-1 line-clamp-3 text-sm text-ink-muted">{excerpt}</p>
      ) : (
        <p className="mt-1 text-sm text-ink-muted">Nothing written today yet.</p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {entry?.transcriptDraft ? <Pill tone="tentative">Transcript to review</Pill> : null}
        {recordings.length > 0 && !entry?.transcriptDraft ? (
          <Pill tone="caution">{recordings.length === 1 ? '1 recording kept' : `${recordings.length} recordings kept`}</Pill>
        ) : null}
      </div>
      <div className="mt-3">
        <ButtonLink href="/capture/journal">Write or record</ButtonLink>
      </div>
    </Card>
  )
}

export default async function CapturePage({ searchParams }: { searchParams: SearchParams }) {
  await requireOwner()
  const sp = await searchParams
  const view = sp.view === 'pinned' ? 'pinned' : 'recent'

  return (
    <>
      <PageHeader title="Capture" subtitle="Notes and journal" actions={<NewNoteButton />} />
      <CaptureSearch>
        <div className="grid items-start gap-4 lg:grid-cols-[1fr_20rem]">
          <Suspense fallback={<Skeleton title="Notes" />}>
            <NotesSection view={view} />
          </Suspense>
          <Suspense fallback={<Skeleton title="Journal" />}>
            <JournalTodayCard />
          </Suspense>
        </div>
      </CaptureSearch>
    </>
  )
}
