import Link from 'next/link'
import type { JournalEntrySummary } from '@personal-home/db'
import { Pill } from '@/components/ui/status-pill'

function label(localDate: string): string {
  const [y, m, d] = localDate.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(Date.UTC(y!, m! - 1, d!)),
  )
}

export function JournalHistory({ entries, current }: { entries: JournalEntrySummary[]; current: string }) {
  return (
    <ul className="divide-y divide-line" data-testid="journal-history">
      {entries.map((e) => (
        <li key={e.id}>
          <Link
            href={`/capture/journal/${e.localDate}`}
            aria-current={e.localDate === current ? 'page' : undefined}
            className="block min-h-11 rounded-lg px-2 py-2.5 hover:bg-surface-muted aria-[current=page]:bg-accent-soft"
          >
            <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
              {label(e.localDate)}
              {e.hasTranscriptDraft ? <Pill tone="tentative">Transcript to review</Pill> : null}
              {e.recordings > 0 && !e.hasTranscriptDraft ? (
                <Pill tone="caution">{e.recordings === 1 ? '1 recording kept' : `${e.recordings} recordings kept`}</Pill>
              ) : null}
            </span>
            {e.preview ? <span className="mt-0.5 line-clamp-2 text-sm text-ink-muted">{e.preview}</span> : null}
          </Link>
        </li>
      ))}
    </ul>
  )
}
