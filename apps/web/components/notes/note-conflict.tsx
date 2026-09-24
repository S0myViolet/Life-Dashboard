'use client'

import { useState } from 'react'
import { notesDisplayTitle, type NoteContent } from '@personal-home/core'
import { Button } from '@/components/ui/button'

function Version({ title, content, testId }: { title: string; content: NoteContent; testId: string }) {
  return (
    <article className="min-w-0 rounded-xl border border-line bg-surface p-3" data-testid={testId}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{title}</h3>
      <p className="mt-2 text-sm font-medium text-ink">{content.title ?? notesDisplayTitle(content)}</p>
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-sm text-ink-muted">
        {content.body || '(empty)'}
      </pre>
    </article>
  )
}

/**
 * Shown when the note changed on another device while this one had unsynced edits to the same
 * fields. Both versions stay intact until the owner picks one or saves a merge.
 */
export function NoteConflict({
  mine,
  theirs,
  proposal,
  onKeepMine,
  onKeepTheirs,
  onMerge,
}: {
  mine: NoteContent
  theirs: NoteContent
  proposal: NoteContent
  onKeepMine: () => void
  onKeepTheirs: () => void
  onMerge: (merged: NoteContent) => void
}) {
  const [merging, setMerging] = useState(false)
  const [title, setTitle] = useState(proposal.title ?? '')
  const [body, setBody] = useState(proposal.body)

  return (
    <section
      aria-labelledby="note-conflict-heading"
      className="mb-5 rounded-[var(--radius-card)] border border-danger/30 bg-danger-soft/40 p-4"
    >
      <h2 id="note-conflict-heading" className="text-[15px] font-semibold text-ink">
        This note was changed on another device
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        Nothing has been overwritten. Choose which version to keep, or merge them.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Version title="This device" content={mine} testId="conflict-mine" />
        <Version title="Saved version" content={theirs} testId="conflict-theirs" />
      </div>
      {merging ? (
        <div className="mt-4 space-y-3">
          <label className="block text-sm font-medium text-ink">
            Merged title
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={300}
              className="mt-1 block min-h-11 w-full rounded-xl border border-line-strong bg-surface px-3 text-sm"
            />
          </label>
          <label className="block text-sm font-medium text-ink">
            Merged note
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="mt-1 block w-full rounded-xl border border-line-strong bg-surface p-3 text-sm"
            />
          </label>
          <p className="text-xs text-ink-faint">
            Where both versions changed the same lines, both are included between marker lines. Edit
            them as you like.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={() => onMerge({ ...proposal, title: title.trim() === '' ? null : title, body })}
            >
              Save merged version
            </Button>
            <Button variant="ghost" onClick={() => setMerging(false)}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" onClick={onKeepMine}>
            Keep this device’s version
          </Button>
          <Button onClick={onKeepTheirs}>Keep saved version</Button>
          <Button onClick={() => setMerging(true)}>Merge…</Button>
        </div>
      )}
    </section>
  )
}
