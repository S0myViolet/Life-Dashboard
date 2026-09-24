import { Card, CardHeader } from '@/components/ui/card'
import { Pill } from '@/components/ui/status-pill'

/**
 * Frame for one Home module: a titled card with an optional status and a
 * "see all" route. Modules keep their own heading id so the section is labelled.
 */
export function ModuleCard({
  id,
  title,
  status,
  href,
  hrefLabel,
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
      <CardHeader id={`${id}-title`} title={title} href={href} hrefLabel={hrefLabel} meta={status} />
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
