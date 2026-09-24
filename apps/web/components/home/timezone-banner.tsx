'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { Globe } from 'lucide-react'
import { buttonClass } from '@/components/ui/button'
import { IDLE_STATE } from '@/lib/settings/action-state'
import { saveTimezoneAction } from '@/lib/settings/actions'
import { useDeviceTimezone } from '@/lib/settings/use-device-timezone'

/**
 * Shown on Home until the owner confirms a timezone. The device's zone is only a
 * suggestion: nothing is saved until "Confirm" is pressed, and afterwards the
 * saved zone stays put until it is changed in Settings.
 */
export function TimezoneBanner({ savedTimezone }: { savedTimezone: string }) {
  const detected = useDeviceTimezone()
  const device = detected === 'pending' ? null : detected
  const [state, action, pending] = useActionState(saveTimezoneAction, IDLE_STATE)
  const suggestion = device ?? savedTimezone

  return (
    <section
      aria-labelledby="tz-banner-title"
      className="mb-5 rounded-[var(--radius-card)] border border-accent/20 bg-accent-soft p-4 sm:p-5"
    >
      <div className="flex items-start gap-3">
        <Globe aria-hidden className="mt-0.5 size-5 shrink-0 text-accent-strong" strokeWidth={1.8} />
        <div className="min-w-0 flex-1">
          <h2 id="tz-banner-title" className="text-[15px] font-semibold text-ink">
            Confirm your timezone
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            {device ? (
              <>
                This device is set to <strong className="text-ink">{device}</strong>.
              </>
            ) : detected === 'pending' ? (
              <>Checking this device&rsquo;s timezone&hellip;</>
            ) : (
              <>This browser did not report a timezone.</>
            )}{' '}
            Until you confirm, Home shows dates and times in{' '}
            <strong className="text-ink">{savedTimezone}</strong>. Nothing is saved until you
            choose.
          </p>
          <form action={action} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="timezone" value={suggestion} />
            <button
              type="submit"
              className={buttonClass('primary')}
              disabled={pending || detected === 'pending'}
            >
              {pending ? 'Saving…' : `Confirm ${suggestion}`}
            </button>
            <Link href="/settings/timezone" className={buttonClass('ghost')}>
              Choose another
            </Link>
          </form>
          <p aria-live="polite" className="mt-2 text-sm">
            {state.status === 'error' ? (
              <span className="text-danger">{state.message}</span>
            ) : state.status === 'saved' ? (
              <span className="text-positive">{state.message}</span>
            ) : null}
          </p>
        </div>
      </div>
    </section>
  )
}
