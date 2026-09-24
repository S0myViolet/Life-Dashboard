/**
 * The date line and short greeting at the top of Home, in the owner's timezone.
 */

export type HomeGreeting = 'Good morning' | 'Good afternoon' | 'Good evening' | 'Hello'

/** Greeting for a local hour 0–23: 05–11 morning, 12–16 afternoon, 17–21 evening, else "Hello". */
export function greetingForLocalHour(hour: number): HomeGreeting {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError(`hour must be an integer 0–23, got ${hour}`)
  }
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 17) return 'Good afternoon'
  if (hour >= 17 && hour < 22) return 'Good evening'
  return 'Hello'
}

export interface HomeHeading {
  greeting: HomeGreeting
  /** e.g. "Thursday 24 September" (en-GB) */
  dateLabel: string
  /** Local calendar date, 'YYYY-MM-DD'. */
  localDate: string
  /** Local hour 0–23. */
  localHour: number
  /** The zone actually used (falls back to UTC only if the saved one is unknown to this runtime). */
  timezone: string
  usedFallback: boolean
}

function parts(instant: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  })
  const map = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]))
  return {
    localDate: `${map.year}-${map.month}-${map.day}`,
    localHour: Number(map.hour) % 24,
  }
}

export function homeHeading(instant: Date, timeZone: string, locale = 'en-GB'): HomeHeading {
  let zone = timeZone
  let usedFallback = false
  try {
    new Intl.DateTimeFormat(locale, { timeZone: zone })
  } catch {
    zone = 'UTC'
    usedFallback = true
  }
  const { localDate, localHour } = parts(instant, zone)
  const dateLabel = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(instant)
  return {
    greeting: greetingForLocalHour(localHour),
    dateLabel,
    localDate,
    localHour,
    timezone: zone,
    usedFallback,
  }
}
