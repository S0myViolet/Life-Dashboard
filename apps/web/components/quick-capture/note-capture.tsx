'use client'

/**
 * Quick capture › Note: a quick note saved through the notes area's own saveNoteAction, or a
 * full note opened in the editor. The note id is generated on the device and kept until the
 * save succeeds, so pressing Save again after a failure never creates a second note (creation
 * is idempotent by id). On failure the text stays in the box.
 */
import Link from 'next/link'
import { useRef, useState, useTransition } from 'react'
import { PenLine } from 'lucide-react'
import { EMPTY_NOTE_CONTENT } from '@personal-home/core'
import { buttonClass } from '@/components/ui/button'
import { labelClass } from '@/components/tasks/ui'
import { NewNoteButton } from '@/components/notes/new-note-button'
import { saveNoteAction } from '@/app/(app)/capture/actions'

type Result =
  | { status: 'idle' }
  | { status: 'saved'; noteId: string }
  /** An earlier attempt with this id was saved (e.g. its reply was lost) with other text. */
  | { status: 'conflict'; noteId: string }
  | { status: 'error'; message: string }

const MESSAGES: Record<string, string> = {
  invalid: 'That note could not be saved: it is too long or has an unsupported character.',
  unauthorized: 'You are signed out. Sign in again; your text is still here.',
  error: 'Could not save right now. Your text is still here; try again.',
  not_found: 'Could not save right now. Your text is still here; try again.',
}

function newId(): string {
  return globalThis.crypto.randomUUID()
}

export function NoteCapture() {
  const [body, setBody] = useState('')
  const [result, setResult] = useState<Result>({ status: 'idle' })
  const [pending, startTransition] = useTransition()
  // Generated lazily on the first save attempt and reused until that note is saved.
  const draftId = useRef<string | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (body.trim() === '') {
      setResult({ status: 'error', message: 'Write something first.' })
      boxRef.current?.focus()
      return
    }
    draftId.current ??= newId()
    const id = draftId.current
    startTransition(async () => {
      let r: Awaited<ReturnType<typeof saveNoteAction>>
      try {
        r = await saveNoteAction({ id, baseVersion: 0, content: { ...EMPTY_NOTE_CONTENT, body } })
      } catch {
        r = { status: 'error', code: 'network' }
      }
      if (r.status === 'saved') {
        setResult({ status: 'saved', noteId: r.note.id })
        setBody('')
        draftId.current = null
        boxRef.current?.focus()
      } else if (r.status === 'conflict') {
        setResult({ status: 'conflict', noteId: id })
        draftId.current = null
      } else {
        setResult({ status: 'error', message: MESSAGES[r.status] ?? MESSAGES.error! })
      }
    })
  }

  return (
    <div className="space-y-3">
      <form
        onSubmit={submit}
        noValidate
        aria-label="Quick note"
        className="space-y-3"
        data-testid="quick-note-form"
      >
        <div>
          <label htmlFor="qc-note" className={labelClass}>
            Quick note
          </label>
          <textarea
            ref={boxRef}
            id="qc-note"
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter saves, like the note editor's keyboard habit.
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                e.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder="A thought, a link, a list…"
            aria-describedby="qc-note-help"
            className="mt-1 block w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-[15px] text-ink placeholder:text-ink-faint"
          />
          <p id="qc-note-help" className="mt-1 text-xs text-ink-muted">
            Saved as an untitled note. Ctrl or ⌘ + Enter saves.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={pending} className={buttonClass('primary')}>
            <PenLine aria-hidden className="size-4" />
            {pending ? 'Saving…' : 'Save note'}
          </button>
          <NewNoteButton variant="secondary" />
        </div>
      </form>
      <div aria-live="polite" className="text-sm">
        {result.status === 'saved' ? (
          <p role="status" className="text-positive">
            Note saved.{' '}
            <Link
              href={`/capture/notes/${result.noteId}`}
              className="inline-flex min-h-11 items-center font-medium text-accent hover:text-accent-strong sm:min-h-0"
            >
              Open note
            </Link>
          </p>
        ) : result.status === 'conflict' ? (
          <p role="alert" className="text-caution">
            An earlier save of this note went through with different text; what you typed is still
            here.{' '}
            <Link
              href={`/capture/notes/${result.noteId}`}
              className="inline-flex min-h-11 items-center font-medium text-accent hover:text-accent-strong sm:min-h-0"
            >
              Open that note
            </Link>
          </p>
        ) : result.status === 'error' ? (
          <p role="alert" className="text-danger">
            {result.message}
          </p>
        ) : null}
      </div>
    </div>
  )
}
