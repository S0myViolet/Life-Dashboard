'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { JOURNAL_BODY_MAX, type JournalEntryContent } from '@personal-home/core'
import { discardJournalTranscriptAction, saveJournalTranscriptAction } from '@/app/(app)/capture/actions'
import { Button } from '@/components/ui/button'
import { idbDelete, idbGet, idbPut } from '@/lib/drafts/idb'
import { journalSnapshot } from '@/lib/drafts/transports'
import type { UseDraftResult } from '@/lib/drafts/use-draft'

interface StoredReview {
  key: string
  kind: 'transcript_review'
  /** The server draft these edits were made on. */
  seen: string
  text: string
  updatedAt: number
}

const reviewKey = (localDate: string) => `transcript_review:${localDate}`

/**
 * The machine transcript is a draft: the owner edits it here and adds it to the entry. It is never
 * saved as final text on its own. Edits in this box are kept on the device (IndexedDB) until they
 * are added or discarded.
 */
export function TranscriptReview({
  localDate,
  transcriptDraft,
  entry,
}: {
  localDate: string
  transcriptDraft: string
  entry: UseDraftResult<JournalEntryContent>
}) {
  const router = useRouter()
  // Adjust local state when a newer server draft arrives (render-time, no effect needed).
  const [seen, setSeen] = useState(transcriptDraft)
  const [text, setText] = useState(transcriptDraft)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  if (transcriptDraft !== seen) {
    // Another transcript was appended: keep the owner's edits and add only the new part.
    setText(transcriptDraft.startsWith(seen) ? text + transcriptDraft.slice(seen.length) : transcriptDraft)
    setSeen(transcriptDraft)
  }

  // Restore edits made on this device before a reload.
  useEffect(() => {
    let alive = true
    void idbGet<StoredReview>('drafts', reviewKey(localDate)).then((stored) => {
      if (alive && stored && stored.seen === transcriptDraft && stored.text !== transcriptDraft) setText(stored.text)
    })
    return () => {
      alive = false
    }
    // Only on first load for this date.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localDate])

  function edit(next: string) {
    setText(next)
    void idbPut('drafts', { key: reviewKey(localDate), kind: 'transcript_review', seen, text: next, updatedAt: Date.now() } satisfies StoredReview)
  }

  async function add() {
    setBusy(true)
    setMessage(null)
    try {
      const flushed = await entry.flush()
      if (!flushed) {
        setMessage('Your typed text has not synced yet. The transcript will be added once it has (try again when online).')
        return
      }
      const baseVersion = entry.server?.version ?? 0
      if (baseVersion < 1) {
        setMessage('This day’s entry is not on the server yet. Try again in a moment.')
        return
      }
      const r = await saveJournalTranscriptAction({ localDate, baseVersion, draftSeen: seen, text })
      switch (r.status) {
        case 'saved':
          await idbDelete('drafts', reviewKey(localDate))
          entry.observeServer(journalSnapshot(r.entry))
          router.refresh()
          return
        case 'draft_changed':
          setMessage('A newer transcript arrived. It has been added below your edits; review it and try again.')
          router.refresh()
          return
        case 'conflict':
          entry.observeServer(journalSnapshot(r.entry))
          setMessage('Your entry changed on another device. Check it above, then add the transcript again.')
          return
        case 'too_long':
          setMessage('The entry would become too long. Shorten the transcript first.')
          return
        case 'invalid':
          setMessage('The transcript is empty. Use “Discard transcript” instead.')
          return
        case 'not_found':
          router.refresh()
          return
        default:
          setMessage('The transcript could not be added right now. Your edits are kept on this device.')
      }
    } catch {
      setMessage('You seem to be offline. Your edits are kept on this device.')
    } finally {
      setBusy(false)
    }
  }

  async function discard() {
    setBusy(true)
    setMessage(null)
    try {
      const r = await discardJournalTranscriptAction({ localDate, draftSeen: seen })
      if (r.status === 'discarded') {
        await idbDelete('drafts', reviewKey(localDate))
        router.refresh()
      } else if (r.status === 'draft_changed') {
        setMessage('A newer transcript arrived; review it before discarding.')
        router.refresh()
      } else {
        setMessage('The transcript could not be discarded right now.')
      }
    } catch {
      setMessage('You seem to be offline. Nothing was discarded.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      aria-labelledby="transcript-heading"
      className="rounded-[var(--radius-card)] border border-tentative/20 bg-tentative-soft p-4"
      data-testid="transcript-review"
    >
      <h2 id="transcript-heading" className="text-[15px] font-semibold text-ink">
        Transcript draft
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        Machine transcription can be wrong. Edit it, then add it to your entry. The recording is
        deleted once the transcript is added.
      </p>
      <label className="mt-3 block text-sm font-medium text-ink">
        Transcript
        <textarea
          value={text}
          onChange={(e) => edit(e.target.value)}
          rows={8}
          maxLength={JOURNAL_BODY_MAX}
          className="mt-1 block w-full rounded-xl border border-line-strong bg-surface p-3 text-[15px] leading-relaxed text-ink"
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => void add()} disabled={busy || text.trim() === ''}>
          Add to entry
        </Button>
        <Button variant="ghost" onClick={() => void discard()} disabled={busy}>
          Discard transcript
        </Button>
      </div>
      {message ? (
        <p role="alert" className="mt-2 text-sm text-ink">
          {message}
        </p>
      ) : null}
    </section>
  )
}
