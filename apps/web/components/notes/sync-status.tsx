'use client'

import { CircleAlert, CloudCheck, CloudOff, HardDrive, Loader } from 'lucide-react'
import { SYNC_INDICATOR_LABELS, type SyncIndicator } from '@/lib/drafts/logic'

const tone: Record<SyncIndicator, string> = {
  synced: 'text-positive',
  saving: 'text-ink-faint',
  saved_local: 'text-ink-muted',
  waiting: 'text-caution',
  conflict: 'text-danger',
  rejected: 'text-danger',
  not_saved: 'text-caution',
}

function Icon({ state }: { state: SyncIndicator }) {
  const cls = 'size-3.5 shrink-0'
  switch (state) {
    case 'synced':
      return <CloudCheck aria-hidden className={cls} />
    case 'saving':
      return <Loader aria-hidden className={cls} />
    case 'saved_local':
      return <HardDrive aria-hidden className={cls} />
    case 'waiting':
    case 'not_saved':
      return <CloudOff aria-hidden className={cls} />
    default:
      return <CircleAlert aria-hidden className={cls} />
  }
}

/** Where the owner's text is right now: on this device, synced, or waiting to sync. */
export function SyncStatus({ state, hidden = false }: { state: SyncIndicator; hidden?: boolean }) {
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="sync-status"
      data-state={state}
      className={`inline-flex items-center gap-1 text-xs font-medium ${tone[state]} ${hidden ? 'invisible' : ''}`}
    >
      <Icon state={state} />
      {SYNC_INDICATOR_LABELS[state]}
    </span>
  )
}
