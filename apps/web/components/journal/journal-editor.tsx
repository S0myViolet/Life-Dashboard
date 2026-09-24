'use client'

import {
  JOURNAL_BODY_MAX,
  JOURNAL_PROMPT_MAX,
  JOURNAL_PROMPTS,
  type JournalEntryContent,
  type JournalPromptKey,
} from '@personal-home/core'
import type { UseDraftResult } from '@/lib/drafts/use-draft'
import { SyncStatus } from '@/components/notes/sync-status'
import { JournalConflict } from './journal-conflict'

/** Typed part of a day's entry: free text plus four optional prompts. No mood fields, by design. */
export function JournalEditor({ draft }: { draft: UseDraftResult<JournalEntryContent> }) {
  const value = draft.value
  const state = draft.draft?.state
  const conflict = draft.draft?.conflict
  const locked = !draft.ready || state === 'conflict'
  const answered = JOURNAL_PROMPTS.filter((p) => (value.prompts[p.key] ?? '').trim() !== '').length
  const setPrompt = (key: JournalPromptKey, text: string) =>
    draft.setValue({ ...value, prompts: { ...value.prompts, [key]: text } })

  return (
    <section aria-labelledby="journal-write-heading">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="journal-write-heading" className="text-[15px] font-semibold text-ink">
          Write
        </h2>
        <SyncStatus state={draft.indicator} hidden={!draft.draft && !draft.server} />
      </div>

      {state === 'conflict' && conflict ? (
        <JournalConflict
          mine={value}
          theirs={conflict.server}
          proposal={conflict.proposal}
          onKeepMine={() => draft.resolve({ choice: 'mine' })}
          onKeepTheirs={() => draft.resolve({ choice: 'theirs' })}
          onMerge={(merged) => draft.resolve({ choice: 'merged', value: merged })}
        />
      ) : null}
      {state === 'rejected' ? (
        <p role="alert" className="mb-3 rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger">
          This entry could not be saved (it may be too long). It is kept on this device.
        </p>
      ) : null}

      <label className="block text-sm font-medium text-ink">
        Entry
        <textarea
          value={value.body}
          onChange={(e) => draft.setValue({ ...value, body: e.target.value })}
          readOnly={locked}
          maxLength={JOURNAL_BODY_MAX}
          rows={9}
          placeholder="Write as much or as little as you like."
          className="mt-1 block w-full rounded-xl border border-line-strong bg-surface p-3 text-[15px] leading-relaxed text-ink"
        />
      </label>

      <details className="mt-3 rounded-xl border border-line bg-surface-muted/40 p-3" open={answered > 0}>
        <summary className="min-h-11 cursor-pointer content-center text-sm font-medium text-ink">
          Prompts <span className="font-normal text-ink-faint">(optional{answered ? ` · ${answered} answered` : ''})</span>
        </summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {JOURNAL_PROMPTS.map((p) => (
            <label key={p.key} className="block text-sm font-medium text-ink">
              {p.label}
              <textarea
                value={value.prompts[p.key] ?? ''}
                onChange={(e) => setPrompt(p.key, e.target.value)}
                readOnly={locked}
                maxLength={JOURNAL_PROMPT_MAX}
                rows={3}
                className="mt-1 block w-full rounded-xl border border-line-strong bg-surface p-2.5 text-sm text-ink"
              />
            </label>
          ))}
        </div>
      </details>
    </section>
  )
}
