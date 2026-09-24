/** Time formatting for connection timestamps (server-rendered; no client clock needed). */

export function formatRelative(date: Date, now: Date): string {
  const diffMs = date.getTime() - now.getTime()
  const past = diffMs <= 0
  const abs = Math.abs(diffMs)
  const min = Math.round(abs / 60_000)
  if (min < 1) return past ? 'just now' : 'in under a minute'
  const phrase = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`
  let text: string
  if (min < 60) text = phrase(min, 'minute')
  else if (min < 48 * 60) text = phrase(Math.round(min / 60), 'hour')
  else text = phrase(Math.round(min / (24 * 60)), 'day')
  return past ? `${text} ago` : `in ${text}`
}

export function formatAbsolute(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date)
  } catch {
    return date.toISOString()
  }
}
