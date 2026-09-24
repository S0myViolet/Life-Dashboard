'use client'

/**
 * Error boundary for one section of a page, so a failing section (for example
 * the reminders list) shows an honest "could not load" state without taking
 * the rest of the page down. Never shows an empty list in place of an error.
 */
import { catchError, type ErrorInfo } from 'next/error'
import { buttonClass } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DataStatePill } from '@/components/ui/status-pill'

function SectionError({ title }: { title: string }, { retry }: ErrorInfo) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        <DataStatePill state="unavailable" />
      </div>
      <p role="alert" className="mt-2 text-sm text-ink-muted">
        This section could not be loaded, so nothing is shown rather than an empty list. Your saved
        data is unchanged.
      </p>
      <button type="button" className={buttonClass('secondary', 'mt-3')} onClick={() => retry()}>
        Try again
      </button>
    </Card>
  )
}

export const SectionBoundary = catchError(SectionError)

export function SectionSkeleton({ label }: { label: string }) {
  return (
    <Card aria-busy="true">
      <p className="text-sm text-ink-muted">{label}</p>
      <div className="mt-3 space-y-2" aria-hidden>
        <div className="h-4 w-2/3 animate-pulse rounded bg-surface-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-surface-muted" />
        <div className="h-4 w-3/5 animate-pulse rounded bg-surface-muted" />
      </div>
    </Card>
  )
}
