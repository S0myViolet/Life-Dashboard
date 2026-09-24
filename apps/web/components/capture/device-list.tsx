import type { CaptureDeviceRow } from '@personal-home/db'
import { EmptyState } from '@/components/ui/empty-state'
import { Pill } from '@/components/ui/status-pill'
import { revokeDeviceAction } from '@/lib/capture/actions'
import { captureFormatDateTime, captureRelativeTime } from '@/lib/capture/view'
import { SubmitButton } from './confirm-submit-button'

/** Paired Chrome helpers. Token values are never shown (only hashes are stored). */
export function DeviceList({
  devices,
  now,
  timeZone,
}: {
  devices: CaptureDeviceRow[]
  now: Date
  timeZone: string
}) {
  if (devices.length === 0) {
    return (
      <EmptyState title="No browser paired yet">
        Create a pairing code above and enter it in the helper&apos;s options page.
      </EmptyState>
    )
  }
  return (
    <ul className="divide-y divide-line">
      {devices.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
              <span className="truncate">{d.name}</span>
              {d.revokedAt ? <Pill>Revoked</Pill> : <Pill tone="positive">Active</Pill>}
            </p>
            <p className="mt-0.5 text-xs text-ink-muted">
              Paired {captureFormatDateTime(d.createdAt, timeZone)} ·{' '}
              {d.revokedAt
                ? `revoked ${captureFormatDateTime(d.revokedAt, timeZone)}`
                : d.lastSeenAt
                  ? `last used ${captureRelativeTime(d.lastSeenAt, now, timeZone)}`
                  : 'not used yet'}
            </p>
          </div>
          {d.revokedAt ? null : (
            <form action={revokeDeviceAction}>
              <input type="hidden" name="deviceId" value={d.id} />
              <SubmitButton
                variant="danger"
                confirm={`Revoke “${d.name}”? It will stop sending captures immediately. Saved conversations are kept.`}
                pendingLabel="Revoking…"
                ariaLabel={`Revoke ${d.name}`}
              >
                Revoke
              </SubmitButton>
            </form>
          )}
        </li>
      ))}
    </ul>
  )
}
