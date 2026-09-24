import 'server-only'
import { isValidTimeZone, localDateInZone } from '@personal-home/core'
import type { Tx } from '@personal-home/db'

export interface OwnerToday {
  /** The owner-local calendar date, 'YYYY-MM-DD'. */
  today: string
  timeZone: string
  /**
   * True when the saved timezone could not be read or is not usable here, so UTC was
   * used. Pages say so rather than silently showing another day's view.
   */
  timeZoneFallback: boolean
}

/**
 * "Today" for Learning and People, in the owner's saved timezone (public.owner_settings,
 * read through the owner's RLS-scoped transaction). Reading-log dates and "caught up
 * today" must be the owner's local date, not the server's UTC date.
 *
 * Once the settings area's repository is merged this can read it through
 * getOwnerSettings(); it only needs the timezone.
 */
export async function ownerToday(tx: Tx, now: Date = new Date()): Promise<OwnerToday> {
  const [row] = await tx<{ timezone: string }[]>`select timezone from public.owner_settings`
  const saved = row?.timezone
  if (saved && isValidTimeZone(saved)) {
    return { today: localDateInZone(now, saved), timeZone: saved, timeZoneFallback: false }
  }
  return { today: localDateInZone(now, 'UTC'), timeZone: 'UTC', timeZoneFallback: true }
}
