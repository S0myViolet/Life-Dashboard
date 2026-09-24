/**
 * Calendar and wall-clock maths for the owner's IANA timezone, using only the
 * platform's Intl data (no timezone library), so it behaves the same in Node,
 * browsers and Deno.
 *
 * Conventions:
 *   - A *local date* is a `'YYYY-MM-DD'` string in some timezone.
 *   - A *wall-clock time* is an `'HH:MM'` string (24-hour).
 *   - An *instant* is a JS `Date` (UTC). The database stores instants as timestamptz.
 *
 * DST policies for converting a local date + time into an instant
 * (the same as Temporal's `disambiguation: 'compatible'`):
 *   - Nonexistent time (spring-forward gap): shift forward by the length of the
 *     gap. 01:30 on 2026-03-29 in Europe/London becomes 02:30 BST (01:30Z).
 *   - Ambiguous time (fall-back overlap): use the earlier instant. 01:30 on
 *     2026-10-25 in Europe/London is 01:30 BST (00:30Z), not 01:30 GMT.
 */
import { z } from 'zod'

const DAY_MS = 86_400_000

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const WALL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export interface LocalDateParts {
  year: number
  month: number
  day: number
}

export interface ZonedDateTimeParts extends LocalDateParts {
  hour: number
  minute: number
  second: number
}

function parseLocalDateParts(localDate: string): LocalDateParts | null {
  const m = LOCAL_DATE_RE.exec(localDate)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1) return null
  // Round-trip through UTC to reject 2026-02-30 and friends.
  const probe = new Date(Date.UTC(year, month - 1, day))
  probe.setUTCFullYear(year)
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null
  }
  return { year, month, day }
}

function requireLocalDate(localDate: string): LocalDateParts {
  const parts = parseLocalDateParts(localDate)
  if (!parts) throw new RangeError(`invalid local date (expected YYYY-MM-DD): ${localDate}`)
  return parts
}

function requireWallTime(time: string): { hour: number; minute: number } {
  const m = WALL_TIME_RE.exec(time)
  if (!m) throw new RangeError(`invalid wall-clock time (expected HH:MM): ${time}`)
  return { hour: Number(m[1]), minute: Number(m[2]) }
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

function formatLocalDate(p: LocalDateParts): string {
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`
}

/** UTC milliseconds for a calendar date/time, treating it as if it were UTC. */
function utcMsOf(p: ZonedDateTimeParts): number {
  const d = new Date(Date.UTC(2000, p.month - 1, p.day, p.hour, p.minute, p.second))
  d.setUTCFullYear(p.year)
  return d.getTime()
}

/** True for a string the platform accepts as an IANA timezone name (in its exact spelling). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false
  // Intl also accepts UTC offsets such as '+05:30'. Those are not IANA zones and
  // have no DST rules, so they are rejected.
  if (!/^[A-Za-z]/.test(tz)) return false
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone
    // Intl matches names case-insensitively; Postgres (owner_settings check) does not.
    return resolved === tz || resolved.toLowerCase() !== tz.toLowerCase()
  } catch {
    return false
  }
}

function requireTimeZone(tz: string): string {
  if (!isValidTimeZone(tz)) throw new RangeError(`invalid IANA timezone: ${tz}`)
  return tz
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatterCache.set(tz, f)
  }
  return f
}

function toEpochMs(instant: Date | number): number {
  const ms = typeof instant === 'number' ? instant : instant.getTime()
  if (!Number.isFinite(ms)) throw new RangeError('invalid instant')
  return ms
}

/** The wall-clock reading of `instant` in `tz` (seconds precision). */
export function zonedDateTimeParts(instant: Date | number, tz: string): ZonedDateTimeParts {
  requireTimeZone(tz)
  const ms = toEpochMs(instant)
  const out: Record<string, number> = {}
  let bc = false
  for (const part of formatterFor(tz).formatToParts(ms)) {
    if (part.type === 'era') bc = part.value.startsWith('B')
    else if (part.type !== 'literal') out[part.type] = Number(part.value)
  }
  const year = bc ? 1 - (out.year ?? 0) : (out.year ?? 0)
  return {
    year,
    month: out.month ?? 1,
    day: out.day ?? 1,
    // Some ICU versions print midnight as 24 even with h23; normalise defensively.
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  }
}

/** Offset of `tz` from UTC at `instant`, in milliseconds (positive east of Greenwich). */
export function timeZoneOffsetMs(instant: Date | number, tz: string): number {
  const ms = toEpochMs(instant)
  const wholeSecond = Math.floor(ms / 1000) * 1000
  return utcMsOf(zonedDateTimeParts(wholeSecond, tz)) - wholeSecond
}

/** The owner-local calendar date of `instant` in `tz`, as 'YYYY-MM-DD'. */
export function localDateInZone(instant: Date | number, tz: string): string {
  return formatLocalDate(zonedDateTimeParts(instant, tz))
}

/** The owner-local wall-clock time of `instant` in `tz`, as 'HH:MM'. */
export function localTimeInZone(instant: Date | number, tz: string): string {
  const p = zonedDateTimeParts(instant, tz)
  return `${pad(p.hour)}:${pad(p.minute)}`
}

/**
 * The UTC instant at which the wall clock in `tz` reads `time` on `localDate`.
 * Gap: shifted forward by the gap length. Overlap: the earlier instant.
 */
export function zonedLocalToUtc(localDate: string, time: string, tz: string): Date {
  requireTimeZone(tz)
  const date = requireLocalDate(localDate)
  const { hour, minute } = requireWallTime(time)
  const wall = utcMsOf({ ...date, hour, minute, second: 0 })

  // Offsets that could apply around this wall time. A day either side covers
  // every real transition (they are at most a few hours long).
  const offsets = new Set<number>([
    timeZoneOffsetMs(wall - DAY_MS, tz),
    timeZoneOffsetMs(wall, tz),
    timeZoneOffsetMs(wall + DAY_MS, tz),
  ])
  const candidates: number[] = []
  for (const offset of offsets) {
    const instant = wall - offset
    if (timeZoneOffsetMs(instant, tz) === offset) candidates.push(instant)
  }
  if (candidates.length > 0) {
    // One candidate normally; two in an overlap, where the earlier one wins.
    return new Date(Math.min(...candidates))
  }
  // Nonexistent wall time: interpret it with the offset in force *before* the
  // transition, which lands the same distance past the transition as the wall
  // time is past the start of the gap (i.e. shifted forward by the gap).
  return new Date(wall - timeZoneOffsetMs(wall - DAY_MS, tz))
}

/** Calendar arithmetic on local dates. Independent of timezone and DST. */
export function addLocalDays(localDate: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError('days must be an integer')
  const p = requireLocalDate(localDate)
  const d = new Date(Date.UTC(2000, p.month - 1, p.day))
  d.setUTCFullYear(p.year)
  d.setUTCDate(d.getUTCDate() + days)
  return formatLocalDate({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  })
}

/** ISO weekday of a local date: Monday = 1 … Sunday = 7. */
export function isoWeekday(localDate: string): number {
  const p = requireLocalDate(localDate)
  const d = new Date(Date.UTC(2000, p.month - 1, p.day))
  d.setUTCFullYear(p.year)
  const js = d.getUTCDay()
  return js === 0 ? 7 : js
}

/** Whole days from `from` to `to` (both local dates); negative when `to` is earlier. */
export function localDaysBetween(from: string, to: string): number {
  const a = requireLocalDate(from)
  const b = requireLocalDate(to)
  const ams = utcMsOf({ ...a, hour: 0, minute: 0, second: 0 })
  const bms = utcMsOf({ ...b, hour: 0, minute: 0, second: 0 })
  return Math.round((bms - ams) / DAY_MS)
}

export interface LocalDailyOccurrence {
  /** The owner-local date this occurrence belongs to. */
  localDate: string
  /** The UTC instant of the occurrence (after DST disambiguation). */
  at: Date
}

function occurrencesAround(instant: number, time: string, tz: string): LocalDailyOccurrence[] {
  const today = localDateInZone(instant, tz)
  const out: LocalDailyOccurrence[] = []
  for (let k = -2; k <= 2; k++) {
    const localDate = addLocalDays(today, k)
    out.push({ localDate, at: zonedLocalToUtc(localDate, time, tz) })
  }
  return out
}

/** The first daily occurrence of `time` in `tz` strictly after `after`. */
export function nextLocalDailyOccurrence(
  after: Date | number,
  time: string,
  tz: string,
): LocalDailyOccurrence {
  requireWallTime(time)
  const ms = toEpochMs(after)
  const next = occurrencesAround(ms, time, tz)
    .filter((o) => o.at.getTime() > ms)
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0]
  if (!next) throw new Error('no next occurrence found')
  return next
}

/** The first instant strictly after `after` at which the wall clock in `tz` reads `time`. */
export function nextLocalDailyRun(after: Date | number, time: string, tz: string): Date {
  return nextLocalDailyOccurrence(after, time, tz).at
}

/** The most recent daily occurrence of `time` in `tz` at or before `atOrBefore`. */
export function latestLocalDailyOccurrence(
  atOrBefore: Date | number,
  time: string,
  tz: string,
): LocalDailyOccurrence {
  requireWallTime(time)
  const ms = toEpochMs(atOrBefore)
  const latest = occurrencesAround(ms, time, tz)
    .filter((o) => o.at.getTime() <= ms)
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0]
  if (!latest) throw new Error('no previous occurrence found')
  return latest
}

/** A valid calendar date string 'YYYY-MM-DD'. */
export const CalendarDateSchema = z
  .string()
  .refine((v) => parseLocalDateParts(v) !== null, { message: 'expected a date as YYYY-MM-DD' })

/** A 24-hour wall-clock time 'HH:MM'. */
export const WallClockTimeSchema = z
  .string()
  .regex(WALL_TIME_RE, { message: 'expected a time as HH:MM (00:00–23:59)' })

/** An IANA timezone name the runtime understands, e.g. 'Europe/London'. */
export const IanaTimeZoneSchema = z
  .string()
  .refine((v) => isValidTimeZone(v), { message: 'expected an IANA timezone name' })
