import { formatReadingPercent } from '@personal-home/core'

/**
 * A reading progress bar. Rendered only when a percentage is honestly known; callers
 * show text instead when it is not (never an empty bar that reads as "0%").
 */
export function ReadingProgressBar({ percent, label }: { percent: number; label: string }) {
  const clamped = Math.min(100, Math.max(0, percent))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.floor(clamped)}
      aria-valuetext={formatReadingPercent(clamped)}
      className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
    >
      <div className="h-full rounded-full bg-accent" style={{ width: `${clamped}%` }} />
    </div>
  )
}
