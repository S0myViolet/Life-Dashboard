import type { ConnectionStatus, DataState } from '@personal-home/core'

type Tone = 'neutral' | 'positive' | 'caution' | 'danger' | 'accent' | 'tentative'

const toneClass: Record<Tone, string> = {
  neutral: 'bg-surface-muted text-ink-muted border-line',
  positive: 'bg-positive-soft text-positive border-positive/20',
  caution: 'bg-caution-soft text-caution border-caution/20',
  danger: 'bg-danger-soft text-danger border-danger/20',
  accent: 'bg-accent-soft text-accent-strong border-accent/20',
  tentative: 'bg-tentative-soft text-tentative border-tentative/20',
}

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${toneClass[tone]}`}
    >
      {children}
    </span>
  )
}

const connectionCopy: Record<ConnectionStatus, { label: string; tone: Tone }> = {
  needs_setup: { label: 'Needs setup', tone: 'neutral' },
  not_connected: { label: 'Not connected', tone: 'neutral' },
  connected: { label: 'Connected', tone: 'positive' },
  syncing: { label: 'Syncing', tone: 'accent' },
  paused: { label: 'Paused', tone: 'caution' },
  needs_reconnect: { label: 'Reconnect needed', tone: 'danger' },
  error: { label: 'Sync failing', tone: 'danger' },
  unsupported: { label: 'Unsupported', tone: 'neutral' },
}

export function ConnectionStatusPill({ status }: { status: ConnectionStatus }) {
  const c = connectionCopy[status]
  return <Pill tone={c.tone}>{c.label}</Pill>
}

const dataCopy: Record<DataState, { label: string; tone: Tone }> = {
  fresh: { label: 'Up to date', tone: 'positive' },
  stale: { label: 'Out of date', tone: 'caution' },
  empty: { label: 'Nothing yet', tone: 'neutral' },
  no_new_activity: { label: 'No new activity', tone: 'neutral' },
  partial: { label: 'Partly synced', tone: 'caution' },
  pending: { label: 'Pending', tone: 'accent' },
  unavailable: { label: 'Unavailable', tone: 'neutral' },
  demo: { label: 'Demo data', tone: 'tentative' },
}

export function DataStatePill({ state }: { state: DataState }) {
  const c = dataCopy[state]
  return <Pill tone={c.tone}>{c.label}</Pill>
}
