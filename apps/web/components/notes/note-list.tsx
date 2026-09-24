import Link from 'next/link'
import { Pin } from 'lucide-react'
import { notesDisplayTitle } from '@personal-home/core'
import type { NoteListItem } from '@personal-home/db'

function formatUpdated(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  )
}

export function NoteList({ notes, timeZone }: { notes: NoteListItem[]; timeZone: string }) {
  return (
    <ul className="divide-y divide-line" data-testid="note-list">
      {notes.map((n) => {
        const title = notesDisplayTitle({ title: n.title, body: n.preview })
        const preview = n.title ? n.preview.replace(/\s+/g, ' ').trim() : ''
        return (
          <li key={n.id}>
            <Link
              href={`/capture/notes/${n.id}`}
              className="block min-h-11 rounded-lg px-2 py-2.5 hover:bg-surface-muted focus-visible:bg-surface-muted"
            >
              <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                {n.pinned ? <Pin aria-label="Pinned" className="size-3.5 shrink-0 text-accent" /> : null}
                <span className="truncate">{title}</span>
              </span>
              {preview ? <span className="mt-0.5 line-clamp-1 text-sm text-ink-muted">{preview}</span> : null}
              <span className="mt-0.5 block text-xs text-ink-faint">
                Edited {formatUpdated(n.updatedAt, timeZone)}
                {n.linkedDate ? ` · for ${n.linkedDate}` : ''}
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
