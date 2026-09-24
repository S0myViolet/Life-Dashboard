/**
 * The AI budget period is the owner's local calendar month, 'YYYY-MM', computed from an instant
 * and the saved IANA timezone. Intl only, so it behaves the same in Node, browsers and Deno.
 */

export const AI_BUDGET_PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    if (typeof timeZone !== 'string' || timeZone.trim() === '') {
      throw new RangeError('timezone is required')
    }
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        calendar: 'gregory',
        numberingSystem: 'latn',
      })
    } catch {
      throw new RangeError(`invalid IANA timezone: ${timeZone.slice(0, 64)}`)
    }
    formatters.set(timeZone, f)
  }
  return f
}

/** Owner-local 'YYYY-MM' for `instant` in `timeZone` (e.g. 'Europe/London'). */
export function aiBudgetPeriod(instant: Date | number, timeZone: string): string {
  const d = instant instanceof Date ? instant : new Date(instant)
  if (Number.isNaN(d.getTime())) throw new RangeError('invalid instant')
  const parts = formatterFor(timeZone).formatToParts(d)
  const year = parts.find((p) => p.type === 'year')?.value ?? ''
  const month = parts.find((p) => p.type === 'month')?.value ?? ''
  const period = `${year}-${month}`
  if (!AI_BUDGET_PERIOD_RE.test(period)) {
    throw new RangeError('instant is outside the supported year range')
  }
  return period
}

export function isAiBudgetPeriod(value: unknown): value is string {
  return typeof value === 'string' && AI_BUDGET_PERIOD_RE.test(value)
}
