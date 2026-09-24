'use client'

import { Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatRecordingClock, RECORDER_ERROR_MESSAGES } from '@/lib/recording/errors'
import { useJournalRecorder, type RecordedAudio } from '@/lib/recording/use-recorder'

/** Record button with a visible timer counting towards the length limit. */
export function JournalRecorder({
  onRecorded,
  disabled = false,
}: {
  onRecorded: (audio: RecordedAudio) => void
  disabled?: boolean
}) {
  const rec = useJournalRecorder(onRecorded)
  const recording = rec.phase === 'recording'
  const remaining = rec.maxSeconds - rec.elapsed

  return (
    <section aria-labelledby="journal-record-heading">
      <h2 id="journal-record-heading" className="mb-2 text-[15px] font-semibold text-ink">
        Record
      </h2>
      <div className="flex flex-wrap items-center gap-3">
        {recording || rec.phase === 'finishing' ? (
          <Button variant="danger" onClick={rec.stop} disabled={rec.phase === 'finishing'}>
            <Square aria-hidden className="size-4" />
            Stop recording
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={() => void rec.start()}
            disabled={disabled || rec.phase === 'starting'}
          >
            <Mic aria-hidden className="size-4" />
            {rec.phase === 'starting' ? 'Waiting for microphone…' : 'Record'}
          </Button>
        )}
        {recording ? (
          <span className="inline-flex items-center gap-2 text-sm text-ink" data-testid="recording-timer">
            <span aria-hidden className="size-2 animate-pulse rounded-full bg-danger" />
            <span className="font-mono tabular-nums">{formatRecordingClock(rec.elapsed)}</span>
            <span className="text-ink-faint">
              of {formatRecordingClock(rec.maxSeconds)}
              {remaining <= 60 ? ` · ${Math.ceil(remaining)} s left` : ''}
            </span>
          </span>
        ) : (
          <span className="text-sm text-ink-faint">Up to {Math.round(rec.maxSeconds / 60)} minutes. You can edit the transcript before it is added.</span>
        )}
      </div>
      {rec.error ? (
        <p role="alert" className="mt-3 rounded-xl border border-caution/30 bg-caution-soft px-3 py-2 text-sm text-ink" data-testid="recorder-error">
          {rec.error === 'empty' ? 'Nothing was recorded. Try again, or type your entry instead.' : RECORDER_ERROR_MESSAGES[rec.error]}
        </p>
      ) : null}
    </section>
  )
}
