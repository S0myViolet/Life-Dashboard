'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ArrowLeft, Pin, PinOff, Trash } from 'lucide-react'
import { NOTE_BODY_MAX, NOTE_TITLE_MAX, type NoteContent, type NoteView } from '@personal-home/core'
import type { NoteLinkOptions } from '@personal-home/db'
import { deleteNoteAction } from '@/app/(app)/capture/actions'
import { Button } from '@/components/ui/button'
import { noteSnapshot, noteTransport } from '@/lib/drafts/transports'
import { useDraft } from '@/lib/drafts/use-draft'
import { NoteConflict } from './note-conflict'
import { SyncStatus } from './sync-status'

const inputClass =
  'mt-1 block min-h-11 w-full rounded-xl border border-line-strong bg-surface px-3 text-sm text-ink disabled:opacity-60'

function LinkSelect({
  label,
  value,
  options,
  onChange,
  emptyHint,
  disabled,
}: {
  label: string
  value: string | null
  options: { id: string; label: string }[]
  onChange: (v: string | null) => void
  emptyHint: string
  disabled: boolean
}) {
  const known = value === null || options.some((o) => o.id === value)
  return (
    <label className="block text-sm font-medium text-ink">
      {label}
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        disabled={disabled || (options.length === 0 && value === null)}
        className={inputClass}
      >
        <option value="">{options.length === 0 && value === null ? emptyHint : 'None'}</option>
        {!known ? <option value={value!}>(linked item not listed)</option> : null}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function NoteEditor({
  id,
  initial,
  isNew,
  links,
}: {
  id: string
  initial: NoteView | null
  isNew: boolean
  links: NoteLinkOptions
}) {
  const router = useRouter()
  const draft = useDraft('note', id, initial ? noteSnapshot(initial) : null, noteTransport)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const value = draft.value
  const set = (patch: Partial<NoteContent>) => draft.setValue({ ...value, ...patch })
  const state = draft.draft?.state
  const conflict = draft.draft?.conflict
  const locked = !draft.ready || state === 'conflict' || state === 'deleted_remotely'
  const missing = draft.ready && !draft.server && !draft.draft && !isNew

  async function remove() {
    setDeleteError(null)
    try {
      const r = await deleteNoteAction(id)
      if (r.status === 'deleted' || r.status === 'not_found') {
        draft.discard()
        router.push('/capture')
        router.refresh()
      } else {
        setDeleteError('The note could not be deleted right now. Try again.')
      }
    } catch {
      setDeleteError('You seem to be offline. The note was not deleted.')
    }
  }

  if (missing) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong p-5 text-sm text-ink-muted">
        <p className="font-medium text-ink">This note does not exist.</p>
        <p className="mt-1">It may have been deleted on another device.</p>
        <Link href="/capture" className="mt-3 inline-block text-accent hover:text-accent-strong">
          Back to notes
        </Link>
      </div>
    )
  }

  const showStatus = Boolean(draft.draft || draft.server)

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/capture"
          className="inline-flex min-h-11 items-center gap-1 rounded-lg px-1 text-sm text-accent hover:text-accent-strong"
        >
          <ArrowLeft aria-hidden className="size-4" />
          All notes
        </Link>
        <div className="flex items-center gap-2">
          <SyncStatus state={draft.indicator} hidden={!showStatus} />
          <Button
            variant="ghost"
            aria-pressed={value.pinned}
            disabled={locked}
            onClick={() => set({ pinned: !value.pinned })}
          >
            {value.pinned ? <PinOff aria-hidden className="size-4" /> : <Pin aria-hidden className="size-4" />}
            {value.pinned ? 'Unpin' : 'Pin'}
          </Button>
        </div>
      </div>

      {state === 'deleted_remotely' ? (
        <section className="mb-5 rounded-[var(--radius-card)] border border-caution/30 bg-caution-soft p-4">
          <h2 className="text-[15px] font-semibold text-ink">This note was deleted on another device</h2>
          <p className="mt-1 text-sm text-ink-muted">Your text below is still on this device.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => draft.resolve({ choice: 'mine' })}>
              Restore note
            </Button>
            <Button
              onClick={() => {
                draft.discard()
                router.push('/capture')
              }}
            >
              Discard my text
            </Button>
          </div>
        </section>
      ) : null}

      {state === 'conflict' && conflict ? (
        <NoteConflict
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
          This note could not be saved (it may be too long). It is kept on this device.
        </p>
      ) : null}

      <form className="space-y-4" onSubmit={(e) => e.preventDefault()} aria-label="Note">
        <label className="block text-sm font-medium text-ink">
          Title <span className="font-normal text-ink-faint">(optional)</span>
          <input
            value={value.title ?? ''}
            onChange={(e) => set({ title: e.target.value === '' ? null : e.target.value })}
            readOnly={locked}
            maxLength={NOTE_TITLE_MAX}
            className={inputClass}
          />
        </label>
        <label className="block text-sm font-medium text-ink">
          Note
          <textarea
            value={value.body}
            onChange={(e) => set({ body: e.target.value })}
            readOnly={locked}
            maxLength={NOTE_BODY_MAX}
            rows={14}
            autoFocus={isNew}
            className="mt-1 block w-full rounded-xl border border-line-strong bg-surface p-3 text-[15px] leading-relaxed text-ink"
          />
        </label>

        <fieldset className="rounded-xl border border-line p-3 sm:p-4">
          <legend className="px-1 text-sm font-medium text-ink">
            Links <span className="font-normal text-ink-faint">(optional)</span>
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <LinkSelect
              label="Project"
              value={value.projectId}
              options={links.projects}
              onChange={(projectId) => set({ projectId })}
              emptyHint="No projects yet"
              disabled={locked}
            />
            <label className="block text-sm font-medium text-ink">
              Date
              <input
                type="date"
                value={value.linkedDate ?? ''}
                onChange={(e) => set({ linkedDate: e.target.value === '' ? null : e.target.value })}
                readOnly={locked}
                className={inputClass}
              />
            </label>
            <LinkSelect
              label="Book"
              value={value.bookId}
              options={links.books}
              onChange={(bookId) => set({ bookId })}
              emptyHint="No books yet"
              disabled={locked}
            />
            <LinkSelect
              label="Person"
              value={value.personId}
              options={links.people}
              onChange={(personId) => set({ personId })}
              emptyHint="No people yet"
              disabled={locked}
            />
          </div>
        </fieldset>
      </form>

      {draft.server ? (
        <div className="mt-6 border-t border-line pt-4">
          {confirmDelete ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-ink">Delete this note permanently?</span>
              <Button variant="danger" onClick={() => void remove()}>
                Delete note
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
              <Trash aria-hidden className="size-4" />
              Delete…
            </Button>
          )}
          {deleteError ? (
            <p role="alert" className="mt-2 text-sm text-danger">
              {deleteError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
