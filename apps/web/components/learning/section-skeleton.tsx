import { Card } from '@/components/ui/card'

/** Loading placeholder for a section while its own query runs. */
export function SectionSkeleton({ title }: { title: string }) {
  return (
    <Card aria-busy="true" aria-label={`${title} (loading)`}>
      <p className="text-[15px] font-semibold tracking-tight text-ink">{title}</p>
      <div className="mt-3 space-y-2" aria-hidden>
        <div className="h-4 w-2/3 animate-pulse rounded bg-surface-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-surface-muted" />
      </div>
    </Card>
  )
}
