import Link from 'next/link'
import { PenLine } from 'lucide-react'
import { PlannedPill } from './module-card'

/** Persistent quick capture at the foot of Home (not part of the reorderable layout). */
export function QuickCapture() {
  return (
    <section
      aria-labelledby="quick-capture-title"
      className="mt-4 rounded-[var(--radius-card)] border border-dashed border-line-strong bg-surface-muted/60 p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="quick-capture-title" className="text-[15px] font-semibold tracking-tight text-ink">
          Quick capture
        </h2>
        <PlannedPill milestone="Milestone 1" />
      </div>
      <p className="mt-2 text-sm text-ink-muted">
        Add a task, a note, a journal recording or a reading log from here without leaving Home.
      </p>
      <Link
        href="/capture"
        className="mt-2 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-accent hover:text-accent-strong sm:min-h-0"
      >
        <PenLine aria-hidden className="size-4" strokeWidth={1.8} />
        Open Capture
      </Link>
    </section>
  )
}
