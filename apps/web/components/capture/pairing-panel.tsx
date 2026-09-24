'use client'

import { useActionState, useEffect, useState } from 'react'
import { createPairingCodeAction, type PairingCodeState } from '@/lib/capture/actions'
import { Button } from '@/components/ui/button'
import { SubmitButton } from './confirm-submit-button'

const initial: PairingCodeState = { status: 'idle' }

function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs, active])
  return now
}

function formatClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  )
}

/**
 * Creates a one-time pairing code. The code is shown here once and never
 * stored in readable form; reloading the page hides it.
 */
export function PairingPanel({
  dashboardOrigin,
  liveCodeExpiresAt,
  timeZone,
}: {
  dashboardOrigin: string | null
  liveCodeExpiresAt: string | null
  timeZone: string
}) {
  const [state, action] = useActionState(createPairingCodeAction, initial)
  const created = state.status === 'created' ? state : null
  const now = useNow(10_000, created !== null)
  const [copied, setCopied] = useState(false)

  const secondsLeft = created ? Math.max(0, Math.round((Date.parse(created.expiresAt) - now) / 1000)) : 0
  const expired = created !== null && secondsLeft === 0

  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-muted">
        <li>Build and load the helper in Chrome (see apps/extension/README.md).</li>
        <li>Open the helper&apos;s options page and enter this dashboard&apos;s address.</li>
        <li>Create a code below and type it into the options page within 10 minutes.</li>
      </ol>

      {dashboardOrigin ? (
        <p className="text-sm text-ink">
          Dashboard address:{' '}
          <code className="rounded-md bg-surface-muted px-1.5 py-0.5 font-mono text-[13px]">
            {dashboardOrigin}
          </code>
        </p>
      ) : (
        <p className="text-sm text-caution">
          APP_URL is not configured, so the helper will use the address it pairs with.
        </p>
      )}

      {created && !expired ? (
        <div
          className="rounded-xl border border-accent/30 bg-accent-soft px-4 py-3"
          role="status"
          aria-live="polite"
        >
          <p className="text-xs font-medium uppercase tracking-wide text-accent-strong">
            One-time pairing code
          </p>
          <p className="mt-1 select-all font-mono text-2xl font-semibold tracking-[0.12em] text-ink">
            {created.code}
          </p>
          <p className="mt-1 text-sm text-ink-muted">
            Valid until {formatClock(created.expiresAt, timeZone)} (about{' '}
            {Math.max(1, Math.ceil(secondsLeft / 60))} min). It works once and is not shown again.
          </p>
          <div className="mt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(created.code)
                  setCopied(true)
                } catch {
                  setCopied(false)
                }
              }}
            >
              {copied ? 'Copied' : 'Copy code'}
            </Button>
          </div>
        </div>
      ) : null}

      {expired ? (
        <p className="text-sm text-caution" role="status">
          That code has expired. Create a new one.
        </p>
      ) : null}

      {state.status === 'error' ? (
        <p className="text-sm text-danger" role="alert">
          {state.message}
        </p>
      ) : null}

      {!created && liveCodeExpiresAt ? (
        <p className="text-sm text-ink-muted">
          A code created earlier is valid until {formatClock(liveCodeExpiresAt, timeZone)}. Creating
          a new code replaces it.
        </p>
      ) : null}

      <form action={action}>
        <SubmitButton variant={created && !expired ? 'secondary' : 'primary'} pendingLabel="Creating…">
          {created && !expired ? 'Create a new code' : 'Create pairing code'}
        </SubmitButton>
      </form>
    </div>
  )
}
