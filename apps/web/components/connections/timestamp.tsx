import { formatAbsolute, formatRelative } from '@/lib/integrations/format'

/** A server-rendered instant: relative text, absolute time in the owner's timezone on hover. */
export function Timestamp({
  date,
  now,
  timeZone,
  empty = 'Never',
}: {
  date: Date | null
  now: Date
  timeZone: string
  empty?: string
}) {
  if (!date) return <span className="text-ink-faint">{empty}</span>
  const absolute = formatAbsolute(date, timeZone)
  return (
    <time dateTime={date.toISOString()} title={absolute}>
      {formatRelative(date, now)}
      <span className="sr-only"> ({absolute})</span>
    </time>
  )
}
