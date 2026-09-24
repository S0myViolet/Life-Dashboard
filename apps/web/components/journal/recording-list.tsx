'use client'

import { useState } from 'react'
import { Download, RotateCcw, Trash, Upload } from 'lucide-react'
import {
  journalFailureIsRetryable,
  journalFailureMessage,
  journalRecordingFileExtension,
  journalTranscriptionIsStale,
  type JournalRecordingView,
} from '@personal-home/core'
import { Button, buttonClass } from '@/components/ui/button'
import { Pill } from '@/components/ui/status-pill'
import { formatRecordingClock } from '@/lib/recording/errors'
import { localRecordingExpiresAt, type LocalRecording } from '@/lib/recording/local-store'
import { UPLOAD_FAILURE_MESSAGES } from '@/lib/recording/upload'

export interface LocalUploadState {
  recording: LocalRecording
  /** Upload in progress: chunks sent / total. */
  progress: { sent: number; total: number; phase: string } | null
}

function formatInstant(iso: string | number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

function size(bytes: number): string {
  return bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`
}

function DeleteButton({ onConfirm, busy }: { onConfirm: () => void; busy: boolean }) {
  const [confirming, setConfirming] = useState(false)
  if (!confirming) {
    return (
      <Button variant="ghost" onClick={() => setConfirming(true)} disabled={busy}>
        <Trash aria-hidden className="size-4" />
        Delete
      </Button>
    )
  }
  return (
    <>
      <Button variant="danger" onClick={onConfirm} disabled={busy}>
        Delete recording
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)}>
        Cancel
      </Button>
    </>
  )
}

function downloadLocal(rec: LocalRecording) {
  const url = URL.createObjectURL(new Blob([rec.data], { type: rec.mimeType }))
  const a = document.createElement('a')
  a.href = url
  a.download = `journal-${rec.localDate}-${rec.id.slice(0, 8)}.${journalRecordingFileExtension(rec.mimeType)}`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function RecordingList({
  server,
  local,
  timeZone,
  now,
  busyIds,
  onRetryUpload,
  onRetryTranscription,
  onDeleteServer,
  onDeleteLocal,
}: {
  server: JournalRecordingView[]
  local: LocalUploadState[]
  timeZone: string
  now: number
  busyIds: ReadonlySet<string>
  onRetryUpload: (id: string) => void
  onRetryTranscription: (id: string) => void
  onDeleteServer: (id: string) => void
  onDeleteLocal: (id: string) => void
}) {
  const localIds = new Set(local.map((l) => l.recording.id))
  const serverOnly = server.filter((s) => !localIds.has(s.id))
  if (local.length === 0 && serverOnly.length === 0) return null

  return (
    <section aria-labelledby="journal-recordings-heading">
      <h2 id="journal-recordings-heading" className="mb-2 text-[15px] font-semibold text-ink">
        Recordings
      </h2>
      <p className="mb-2 text-xs text-ink-faint">
        A recording is deleted once its transcript is added to your entry. Recordings that were not
        transcribed are kept for up to seven days so you can retry, download or delete them.
      </p>
      <ul className="space-y-2">
        {local.map(({ recording: rec, progress }) => {
          const busy = busyIds.has(rec.id) || progress !== null
          return (
            <li key={rec.id} className="rounded-xl border border-line bg-surface p-3" data-testid="recording-item" data-status="local">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Pill tone="caution">{progress ? 'Uploading' : 'On this device only'}</Pill>
                <span className="text-ink-muted">
                  {rec.durationSeconds ? formatRecordingClock(rec.durationSeconds) : ''} · {size(rec.byteSize)}
                </span>
              </div>
              <p className="mt-1 text-sm text-ink">
                {progress
                  ? progress.phase === 'finishing'
                    ? 'Finishing upload and transcribing…'
                    : `Uploading… ${progress.sent} of ${progress.total} parts`
                  : rec.lastError
                    ? UPLOAD_FAILURE_MESSAGES[rec.lastError]
                    : 'Not uploaded yet.'}
              </p>
              <p className="mt-1 text-xs text-ink-faint">
                Kept on this device until {formatInstant(localRecordingExpiresAt(rec), timeZone)}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button onClick={() => onRetryUpload(rec.id)} disabled={busy}>
                  <Upload aria-hidden className="size-4" />
                  Retry upload
                </Button>
                <Button variant="ghost" onClick={() => downloadLocal(rec)}>
                  <Download aria-hidden className="size-4" />
                  Download
                </Button>
                <DeleteButton onConfirm={() => onDeleteLocal(rec.id)} busy={busy} />
              </div>
            </li>
          )
        })}
        {serverOnly.map((rec) => {
          const busy = busyIds.has(rec.id)
          const stale = rec.status === 'transcribing' && journalTranscriptionIsStale(rec.transcribingSince, new Date(now))
          const failed = rec.status === 'failed' || stale
          let label: string
          let tone: 'neutral' | 'caution' | 'danger' | 'accent' | 'positive' | 'tentative' = 'neutral'
          let message: string
          switch (rec.status) {
            case 'uploading':
              label = 'Upload incomplete'
              tone = 'caution'
              message = 'This upload did not finish (it may have been started on another device).'
              break
            case 'uploaded':
              label = 'Uploaded'
              tone = 'accent'
              message = 'Waiting for transcription.'
              break
            case 'transcribing':
              label = stale ? 'Interrupted' : 'Transcribing'
              tone = stale ? 'caution' : 'accent'
              message = stale ? journalFailureMessage('interrupted') : 'Transcribing…'
              break
            case 'transcribed':
              label = 'Transcribed'
              tone = 'tentative'
              message = 'The transcript is waiting for your review above.'
              break
            default:
              label = rec.failureReason === 'not_configured' ? 'Not transcribed' : 'Transcription failed'
              tone = 'caution'
              message = journalFailureMessage(rec.failureReason, rec.mimeType)
          }
          const canRetry =
            rec.status === 'uploaded' || stale || (rec.status === 'failed' && journalFailureIsRetryable(rec.failureReason))
          const downloadable = rec.status !== 'uploading'
          return (
            <li
              key={rec.id}
              className="rounded-xl border border-line bg-surface p-3"
              data-testid="recording-item"
              data-status={failed ? 'failed' : rec.status}
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Pill tone={tone}>{label}</Pill>
                <span className="text-ink-muted">
                  {rec.durationSeconds ? formatRecordingClock(rec.durationSeconds) : ''} · {size(rec.byteSize)}
                </span>
              </div>
              <p className="mt-1 text-sm text-ink" data-testid="recording-message">
                {message}
              </p>
              <p className="mt-1 text-xs text-ink-faint" data-testid="recording-expiry">
                Kept until {formatInstant(rec.expiresAt, timeZone)}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {canRetry ? (
                  <Button onClick={() => onRetryTranscription(rec.id)} disabled={busy}>
                    <RotateCcw aria-hidden className="size-4" />
                    {busy ? 'Retrying…' : rec.status === 'uploaded' ? 'Transcribe' : 'Retry'}
                  </Button>
                ) : null}
                {downloadable ? (
                  <a
                    href={`/api/journal/recordings/${rec.id}/audio`}
                    download
                    className={buttonClass('ghost')}
                  >
                    <Download aria-hidden className="size-4" />
                    Download
                  </a>
                ) : null}
                <DeleteButton onConfirm={() => onDeleteServer(rec.id)} busy={busy} />
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
