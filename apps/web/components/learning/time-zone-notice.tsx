import Link from 'next/link'
import { withOwnerTx } from '@/lib/server/session'
import { ownerToday } from './owner-today'

/**
 * Shown only when the saved timezone could not be used: "today" (for reading logs and
 * catch-ups) is then UTC's date, and the owner should know.
 */
export async function TimeZoneNotice() {
  const { timeZoneFallback, today } = await withOwnerTx((tx) => ownerToday(tx))
  if (!timeZoneFallback) return null
  return (
    <p
      role="status"
      className="mb-4 rounded-xl border border-caution/20 bg-caution-soft px-3 py-2 text-sm text-caution"
    >
      Your timezone could not be read, so dates use UTC (today is {today}).{' '}
      <Link href="/settings" className="underline">
        Check Settings
      </Link>
      .
    </p>
  )
}
