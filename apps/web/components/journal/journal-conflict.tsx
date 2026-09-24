'use client'

import { useState } from 'react'
import { JOURNAL_PROMPTS, type JournalEntryContent } from '@personal-home/core'
import { Button } from '@/components/ui/button'

function Side({ title, content, testId }: { title: string; content: JournalEntryContent; testId: string }) {
  return (
    <article className="min-w-0 rounded-xl border border-line bg-surface p-3" data-testid={testId}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{title}</h3>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-sm text-ink">
        {content.body || '(no entry text)'}
      </pre>
      {JOURNAL_PROMPTS.filter((p) => content.prompts[p.key]).map((p) => (
        <p key={p.key} className="mt-2 text-sm text-ink-muted">
          <span className="font-medium text-ink">{p.label}:</span> {content.prompts[p.key]}
        </p>
      ))}
    </article>
  )
}

/** Both devices changed the same part of this day's entry: nothing is lost until the owner chooses. */
export function JournalConflict({
  mine,
  theirs,
  proposal,
  onKeepMine,
  onKeepTheirs,
  onMerge,
}: {
  mine: JournalEntryContent
  theirs: JournalEntryContent
  proposal: JournalEntryContent
  onKeepMine: () => void
  onKeepTheirs: () => void
  onMerge: (merged: JournalEntryContent) => void
}) {
  const [merging, setMerging] = useState(false)
  const [body, setBody] = useState(proposal.body)
  return (
    <section
      aria-labelledby="journal-conflict-heading"
      className="mb-4 rounded-[var(--radius-card)] border border-danger/30 bg-danger-soft/40 p-4"
    >
      <h2 id="journal-conflict-heading" className="text-[15px] font-semibold text-ink">
        This entry was changed on another device
      </h2>
      <p className="mt-1 text-sm text-ink-muted">Nothing has been overwritten. Choose a version, or merge them.</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Side title="This device" content={mine} testId="conflict-mine" />
        <Side title="Saved version" content={theirs} testId="conflict-theirs" />
      </div>
      {merging ? (
        <div className="mt-4 space-y-3">
          <label className="block text-sm font-medium text-ink">
            Merged entry
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="mt-1 block w-full rounded-xl border border-line-strong bg-surface p-3 text-sm"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => onMerge({ ...proposal, body })}>
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
