/**
 * Server-side helpers shared by the Capture pages. Reads always go through withOwnerTx (RLS).
 */
import 'server-only'
import { isValidTimeZone, localDateInZone } from '@personal-home/core'
import type { Tx } from '@personal-home/db'

export const FALLBACK_TIMEZONE = 'Europe/London'

/** The owner's saved IANA timezone (owner_settings), which defines "today" for the journal. */
export async function ownerTimezone(tx: Tx): Promise<string> {
  const [row] = await tx<{ timezone: string }[]>`select timezone from public.owner_settings limit 1`
  return row && isValidTimeZone(row.timezone) ? row.timezone : FALLBACK_TIMEZONE
}

export async function ownerToday(tx: Tx, now: Date = new Date()): Promise<{ timezone: string; today: string }> {
  const timezone = await ownerTimezone(tx)
  return { timezone, today: localDateInZone(now, timezone) }
}

/** 'YYYY-MM-DD' → 'Thursday 24 September 2026' (a calendar date, so no timezone shift). */
export function formatLocalDate(localDate: string, o: { weekday?: boolean; year?: boolean } = {}): string {
  const [y, m, d] = localDate.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: o.weekday === false ? undefined : 'long',
    day: 'numeric',
    month: 'long',
    year: o.year === false ? undefined : 'numeric',
  }).format(new Date(Date.UTC(y!, m! - 1, d!)))
}
