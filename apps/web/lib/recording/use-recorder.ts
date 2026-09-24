'use client'

/**
 * MediaRecorder with runtime format detection (WebM/Opus on desktop Chrome, MP4/AAC on iPhone
 * Safari), a hard length limit with a visible timer, and honest errors for a denied or missing
 * microphone. The audio never leaves the browser from here; the caller stores and uploads it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  JOURNAL_RECORDER_BITS_PER_SECOND,
  JOURNAL_RECORDING_MAX_SECONDS,
  journalNormalizeRecordedMime,
  journalPickRecorderMimeType,
} from '@personal-home/core'
import { recorderErrorOf, recorderSupport, type RecorderError } from './errors'

export interface RecordedAudio {
  data: ArrayBuffer
  mimeType: string
  durationSeconds: number
  /** Stopped automatically at the length limit. */
  hitLimit: boolean
}

export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'finishing'

export function useJournalRecorder(
  onRecorded: (audio: RecordedAudio) => void,
  maxSeconds: number = JOURNAL_RECORDING_MAX_SECONDS,
) {
  const [phase, setPhase] = useState<RecorderPhase>('idle')
  const [error, setError] = useState<RecorderError | 'empty' | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hitLimitRef = useRef(false)
  const onRecordedRef = useRef(onRecorded)

  useEffect(() => {
    onRecordedRef.current = onRecorded
  }, [onRecorded])

  const releaseDevice = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  const stop = useCallback(() => {
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') {
      setPhase('finishing')
      try {
        rec.stop()
      } catch {
        releaseDevice()
        setPhase('idle')
      }
    }
  }, [releaseDevice])

  const start = useCallback(async () => {
    setError(null)
    const support = recorderSupport({
      isSecureContext: typeof window !== 'undefined' ? window.isSecureContext : undefined,
      hasGetUserMedia: typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function',
      hasMediaRecorder: typeof MediaRecorder !== 'undefined',
    })
    if (support) {
      setError(support)
      return
    }
    setPhase('starting')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch (err) {
      setError(recorderErrorOf(err))
      setPhase('idle')
      return
    }
    streamRef.current = stream

    const preferred = journalPickRecorderMimeType((t) => MediaRecorder.isTypeSupported(t))
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(
        stream,
        preferred
          ? { mimeType: preferred, audioBitsPerSecond: JOURNAL_RECORDER_BITS_PER_SECOND }
          : { audioBitsPerSecond: JOURNAL_RECORDER_BITS_PER_SECOND },
      )
    } catch {
      try {
        recorder = new MediaRecorder(stream)
      } catch (err) {
        releaseDevice()
        setError(recorderErrorOf(err) === 'failed' ? 'unsupported' : recorderErrorOf(err))
        setPhase('idle')
        return
      }
    }
    recorderRef.current = recorder
    hitLimitRef.current = false
    const parts: Blob[] = []
    const startedAt = performance.now()

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) parts.push(e.data)
    }
    recorder.onerror = () => {
      setError('failed')
    }
    recorder.onstop = () => {
      const durationSeconds = Math.round(((performance.now() - startedAt) / 1000) * 100) / 100
      releaseDevice()
      recorderRef.current = null
      const mimeType = journalNormalizeRecordedMime(recorder.mimeType, parts[0]?.type, preferred)
      const blob = new Blob(parts, mimeType ? { type: mimeType } : undefined)
      if (!mimeType) {
        setError('unsupported')
        setPhase('idle')
        return
      }
      if (blob.size === 0) {
        setError('empty')
        setPhase('idle')
        return
      }
      void blob.arrayBuffer().then(
        (data) => {
          setPhase('idle')
          onRecordedRef.current({ data, mimeType, durationSeconds, hitLimit: hitLimitRef.current })
        },
        () => {
          setError('failed')
          setPhase('idle')
        },
      )
    }

    try {
      // Timeslices keep memory bounded and give us data even if the page is closed abruptly.
      recorder.start(1000)
    } catch (err) {
      releaseDevice()
      recorderRef.current = null
      setError(recorderErrorOf(err))
      setPhase('idle')
      return
    }
    setElapsed(0)
    setPhase('recording')
    timerRef.current = setInterval(() => {
      const secs = (performance.now() - startedAt) / 1000
      setElapsed(secs)
      if (secs >= maxSeconds) {
        hitLimitRef.current = true
        stop()
      }
    }, 250)
  }, [maxSeconds, releaseDevice, stop])

  // Leaving the page stops the microphone; an in-progress recording is finished and handed over.
  useEffect(
    () => () => {
      const rec = recorderRef.current
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop()
        } catch {
          // ignore
        }
      }
      if (timerRef.current) clearInterval(timerRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    },
    [],
  )

  return { phase, error, elapsed, maxSeconds, start, stop, clearError: () => setError(null) }
}
