import Link from 'next/link'
import type { JournalSearchHit, NoteSearchHit } from '@personal-home/db'
import { EmptyState } from '@/components/ui/empty-state'
import { Highlighted } from './highlighted'

export function SearchResults({
  query,
  notes,
  journal,
}: {
  query: string
  notes: NoteSearchHit[]
  journal: JournalSearchHit[]
}) {
  if (notes.length === 0 && journal.length === 0) {
    return (
      <EmptyState title={`Nothing found for “${query}”`}>
        Search looks for every word (and words starting with them) in note titles, notes and journal
        entries.
      </EmptyState>
    )
  }
  return (
    <div className="space-y-6" data-testid="search-results">
      {notes.length > 0 ? (
        <section aria-labelledby="note-hits">
          <h2 id="note-hits" className="mb-2 text-[15px] font-semibold text-ink">
            Notes <span className="font-normal text-ink-faint">({notes.length})</span>
          </h2>
          <ul className="divide-y divide-line">
            {notes.map((h) => (
              <li key={h.id}>
                <Link
                  href={`/capture/notes/${h.id}`}
                  className="block min-h-11 rounded-lg px-2 py-2.5 hover:bg-surface-muted"
                  data-testid="note-hit"
                >
                  <span className="block text-sm font-medium text-ink">
                    {h.titleHighlight ? <Highlighted snippet={h.titleHighlight} /> : 'Untitled note'}
                  </span>
                  <Highlighted snippet={h.snippet} className="mt-0.5 block text-sm text-ink-muted" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {journal.length > 0 ? (
        <section aria-labelledby="journal-hits">
          <h2 id="journal-hits" className="mb-2 text-[15px] font-semibold text-ink">
            Journal <span className="font-normal text-ink-faint">({journal.length})</span>
          </h2>
          <ul className="divide-y divide-line">
            {journal.map((h) => (
              <li key={h.id}>
                <Link
                  href={`/capture/journal/${h.localDate}`}
                  className="block min-h-11 rounded-lg px-2 py-2.5 hover:bg-surface-muted"
                  data-testid="journal-hit"
                >
                  <span className="block text-sm font-medium text-ink">{h.localDate}</span>
                  <Highlighted snippet={h.snippet} className="mt-0.5 block text-sm text-ink-muted" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
