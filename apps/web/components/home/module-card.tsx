import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Pill } from '@/components/ui/status-pill'

/**
 * Frame for one Home module: a titled card with an optional status and a
 * "see all" route. Modules keep their own heading id so the section is labelled.
 *
 * The header mirrors components/ui/card.tsx CardHeader, except that the route
 * link is a 44px touch target on phones (CardHeader's link is ~24px tall). The
 * negative margin keeps the header's visual height unchanged.
 */
export function ModuleCard({
  id,
  title,
  status,
  href,
  hrefLabel = 'See all',
  wide = false,
  children,
}: {
  id: string
  title: string
  status?: React.ReactNode
  href?: string
  hrefLabel?: string
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <Card
      aria-labelledby={`${id}-title`}
      data-home-module={id}
      className={wide ? 'lg:col-span-2' : ''}
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2
            id={`${id}-title`}
            className="truncate text-[15px] font-semibold tracking-tight text-ink"
          >
            {title}
          </h2>
          {status ? <div className="shrink-0 text-xs text-ink-faint">{status}</div> : null}
        </div>
        {href ? (
          <Link
            href={href}
            className="-my-2.5 inline-flex min-h-11 shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 text-sm text-accent hover:text-accent-strong sm:my-0 sm:min-h-0"
          >
            {hrefLabel}
            <ChevronRight aria-hidden className="size-4" />
          </Link>
        ) : null}
      </div>
      <div className="space-y-3 text-sm text-ink-muted">{children}</div>
    </Card>
  )
}

/** Honest label for a module whose data arrives in a later milestone. */
export function PlannedPill({ milestone }: { milestone: string }) {
  return <Pill>Planned · {milestone}</Pill>
}

/** Placeholder while a module loads. Mirrors the card's size to avoid layout shift. */
export function ModuleSkeleton({ title, wide = false }: { title: string; wide?: boolean }) {
  return (
    <Card aria-busy="true" aria-label={`${title} loading`} className={wide ? 'lg:col-span-2' : ''}>
      <div className="mb-3 h-4 w-32 animate-pulse rounded bg-surface-muted" />
      <div className="space-y-2">
        <div className="h-3 w-full animate-pulse rounded bg-surface-muted" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-surface-muted" />
      </div>
    </Card>
  )
}
