/**
 * Recordings kept on this device until the server has all of them (an upload that failed or was
 * interrupted must never lose what the owner said). Stored as ArrayBuffers in IndexedDB (Blob
 * storage is unreliable in some Safari versions), deleted once the upload completes, and never
 * kept longer than the server-side retention (seven days).
 */
import { JOURNAL_RECORDING_RETENTION_DAYS } from '@personal-home/core'
import { idbDelete, idbGetAll, idbPut } from '@/lib/drafts/idb'
import type { UploadFailureCode } from './upload'

export interface LocalRecording {
  id: string
  localDate: string
  mimeType: string
  durationSeconds: number | null
  byteSize: number
  data: ArrayBuffer
  createdAt: number
  lastError: UploadFailureCode | null
}

const RETENTION_MS = JOURNAL_RECORDING_RETENTION_DAYS * 86_400_000

export function localRecordingExpiresAt(rec: Pick<LocalRecording, 'createdAt'>): number {
  return rec.createdAt + RETENTION_MS
}

/** Returns false when the device could not store it (the UI then says so). */
export function saveLocalRecording(rec: LocalRecording): Promise<boolean> {
  return idbPut('recordings', rec)
}

export async function listLocalRecordings(now = Date.now()): Promise<LocalRecording[]> {
  const all = await idbGetAll<LocalRecording>('recordings')
  const live: LocalRecording[] = []
  for (const rec of all) {
    if (!rec || typeof rec.id !== 'string') continue
    if (localRecordingExpiresAt(rec) <= now) await idbDelete('recordings', rec.id)
    else live.push(rec)
  }
  return live.sort((a, b) => a.createdAt - b.createdAt)
}

export function deleteLocalRecording(id: string): Promise<void> {
  return idbDelete('recordings', id)
}
