import { Card } from '@/components/ui/card'

/**
 * Honest placeholder for a section whose milestone has not been built yet.
 * States plainly what is coming; never shows fabricated data.
 */
export function PlannedSection({
  milestone,
  children,
}: {
  milestone: string
  children: React.ReactNode
}) {
  return (
    <Card>
      <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
        Planned · {milestone}
      </p>
      <div className="mt-2 space-y-2 text-sm text-ink-muted">{children}</div>
    </Card>
  )
}
