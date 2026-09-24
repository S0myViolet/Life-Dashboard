'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { JournalEntryView, JournalRecordingView } from '@personal-home/core'
import { idbDelete } from '@/lib/drafts/idb'
import { journalSnapshot, journalTransport } from '@/lib/drafts/transports'
import { useDraft } from '@/lib/drafts/use-draft'
import {
  deleteLocalRecording,
  listLocalRecordings,
  saveLocalRecording,
  type LocalRecording,
} from '@/lib/recording/local-store'
import { uploadJournalRecording } from '@/lib/recording/upload'
import type { RecordedAudio } from '@/lib/recording/use-recorder'
import { JournalEditor } from './journal-editor'
import { JournalRecorder } from './journal-recorder'
import { RecordingList, type LocalUploadState } from './recording-list'
import { TranscriptReview, transcriptReviewKey } from './transcript-review'

type Progress = LocalUploadState['progress']

/**
 * One day of the journal: typing (offline drafts), optional prompts, voice recording with
 * resumable upload, transcript review, and the kept recordings with Retry / Download / Delete.
 * Typing always works, whatever happens to the microphone, the upload or the transcription.
 */
export function JournalDay({
  localDate,
  entry,
  recordings,
  timeZone,
}: {
  localDate: string
  entry: JournalEntryView | null
  recordings: JournalRecordingView[]
  timeZone: string
}) {
  const router = useRouter()
  const draft = useDraft('journal', localDate, entry ? journalSnapshot(entry) : null, journalTransport)
  const [local, setLocal] = useState<LocalRecording[]>([])
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const uploading = useRef(new Set<string>())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  // No transcript waiting (added or discarded, here or elsewhere): drop any review edits kept on
  // this device for it, so journal text does not linger in local storage.
  const hasTranscript = Boolean(entry?.transcriptDraft)
  useEffect(() => {
    if (!hasTranscript) void idbDelete('drafts', transcriptReviewKey(localDate))
  }, [hasTranscript, localDate])

  const reloadLocal = useCallback(async () => {
    const all = await listLocalRecordings()
    setLocal(all)
    return all
  }, [])

  const upload = useCallback(
    async (rec: LocalRecording) => {
      if (uploading.current.has(rec.id)) return
      uploading.current.add(rec.id)
      setProgress((p) => ({ ...p, [rec.id]: { sent: 0, total: 0, phase: 'registering' } }))
      try {
        const outcome = await uploadJournalRecording(rec, {
          fetch: (input, init) => window.fetch(input, init),
          onProgress: (p) =>
            setProgress((prev) => ({ ...prev, [rec.id]: { sent: p.sentChunks, total: p.totalChunks, phase: p.phase } })),
        })
        if (outcome.status === 'uploaded') {
          await deleteLocalRecording(rec.id)
          setNotice(null)
        } else {
          await saveLocalRecording({ ...rec, lastError: outcome.code })
        }
      } finally {
        uploading.current.delete(rec.id)
        setProgress((p) => {
          const next = { ...p }
          delete next[rec.id]
          return next
        })
        await reloadLocal()
        router.refresh()
      }
    },
    [reloadLocal, router],
  )

  // Resume uploads left on this device (page closed mid-upload, or offline), now and when back online.
  useEffect(() => {
    let alive = true
    const resume = async () => {
      const all = await reloadLocal()
      if (!alive) return
      for (const rec of all) {
        if (rec.lastError === 'mismatch' || rec.lastError === 'id_conflict' || rec.lastError === 'rejected') continue
        void upload(rec)
      }
    }
    void resume()
    window.addEventListener('online', resume)
    return () => {
      alive = false
      window.removeEventListener('online', resume)
    }
  }, [reloadLocal, upload])

  const onRecorded = useCallback(
    async (audio: RecordedAudio) => {
      const rec: LocalRecording = {
        id: crypto.randomUUID(),
        localDate,
        mimeType: audio.mimeType,
        durationSeconds: audio.durationSeconds,
        byteSize: audio.data.byteLength,
        data: audio.data,
        createdAt: Date.now(),
        lastError: null,
      }
      const kept = await saveLocalRecording(rec)
      setNotice(
        [
          audio.hitLimit ? 'Recording stopped at the length limit.' : null,
          kept ? null : 'This device could not keep a backup copy; uploading now.',
        ]
          .filter(Boolean)
          .join(' ') || null,
      )
      if (kept) await reloadLocal()
      else setLocal((l) => [...l, rec])
      await upload(rec)
    },
    [localDate, reloadLocal, upload],
  )

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusy((b) => new Set(b).add(id))
    try {
      await fn()
    } finally {
      setBusy((b) => {
        const n = new Set(b)
        n.delete(id)
        return n
      })
      router.refresh()
    }
  }

  const retryTranscription = (id: string) =>
    withBusy(id, async () => {
      try {
        const res = await fetch(`/api/journal/recordings/${id}/retry`, { method: 'POST' })
        if (!res.ok) setNotice('Retry did not go through. Check your connection and try again.')
      } catch {
        setNotice('You seem to be offline. Try again when you are back online.')
      }
    })

  const deleteServer = (id: string) =>
    withBusy(id, async () => {
      try {
        const res = await fetch(`/api/journal/recordings/${id}`, { method: 'DELETE' })
        if (!res.ok && res.status !== 404) setNotice('The recording could not be deleted right now.')
      } catch {
        setNotice('You seem to be offline. Nothing was deleted.')
      }
    })

  const deleteLocal = (id: string) =>
    withBusy(id, async () => {
      await deleteLocalRecording(id)
      // Also remove any partial upload on the server.
      await fetch(`/api/journal/recordings/${id}`, { method: 'DELETE' }).catch(() => null)
      await reloadLocal()
    })

  const localForDay: LocalUploadState[] = local
    .filter((r) => r.localDate === localDate)
    .map((recording) => ({ recording, progress: progress[recording.id] ?? null }))

  return (
    <div className="space-y-6">
      <JournalEditor draft={draft} />
      {entry?.transcriptDraft ? (
        <TranscriptReview localDate={localDate} transcriptDraft={entry.transcriptDraft} entry={draft} />
      ) : null}
      <JournalRecorder onRecorded={(a) => void onRecorded(a)} />
      {notice ? (
        <p role="status" className="text-sm text-ink-muted">
          {notice}
        </p>
      ) : null}
      <RecordingList
        server={recordings}
        local={localForDay}
        timeZone={timeZone}
        now={now}
        busyIds={busy}
        onRetryUpload={(id) => {
          const rec = local.find((r) => r.id === id)
          if (rec) void upload({ ...rec, lastError: null })
        }}
        onRetryTranscription={(id) => void retryTranscription(id)}
        onDeleteServer={(id) => void deleteServer(id)}
        onDeleteLocal={(id) => void deleteLocal(id)}
      />
    </div>
  )
}
