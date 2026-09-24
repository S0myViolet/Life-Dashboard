/**
 * Week view: seven days with tasks due, accepted blocks and busy events. Busy events show as
 * "not connected" until calendars sync (Milestone 2): never a fabricated zero.
 */
import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { unstable_rethrow } from 'next/navigation'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { loadPlanWeek, type PlanWeekData } from '@/lib/planner/server'
import { planCount, planLongDateLabel } from '@/lib/planner/view'

export async function PlanWeek({ start }: { start?: string }) {
  let data: PlanWeekData
  try {
    data = await loadPlanWeek(start)
  } catch (error) {
    unstable_rethrow(error)
    console.error(
      '[planner] could not load the week view:',
      error instanceof Error ? error.message : 'unknown error',
    )
    return (
      <Card>
        <EmptyState title="This week could not be loaded.">Try again in a moment.</EmptyState>
      </Card>
    )
  }
  const link =
    'inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm text-accent hover:bg-surface-muted hover:text-accent-strong'
  const end = data.days[data.days.length - 1]!.localDate
  return (
    <div className="space-y-4">
      <nav aria-label="Change week" className="flex items-center justify-between gap-2">
        <Link href={`/plan/week?start=${data.prevStart}`} className={link}>
          <ChevronLeft aria-hidden className="size-4" /> Previous week
        </Link>
        <p className="text-center text-sm font-medium text-ink">
          {planLongDateLabel(data.start).replace(/^\w+ /, '')} –{' '}
          {planLongDateLabel(end).replace(/^\w+ /, '')}
        </p>
        <Link href={`/plan/week?start=${data.nextStart}`} className={link}>
          Next week <ChevronRight aria-hidden className="size-4" />
        </Link>
      </nav>
      <p className="text-xs text-ink-muted">
        Busy events appear here once a calendar is connected.
      </p>
      <ol className="space-y-2" data-testid="plan-week">
        {data.days.map((d) => (
          <li key={d.localDate}>
            <Link
              href={d.href}
              aria-current={d.isToday ? 'date' : undefined}
              className={`flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border px-4 py-3 hover:bg-surface-muted ${
                d.isToday ? 'border-accent/50 bg-accent-soft/40' : 'border-line bg-surface'
              }`}
            >
              <span className="text-sm font-medium text-ink">
                {d.label}
                {d.isToday ? <span className="text-ink-muted"> · Today</span> : null}
              </span>
              <span className="flex flex-wrap gap-x-3 text-xs text-ink-muted">
                <span>{planCount(d.tasksDue, 'task')} due</span>
                <span>
                  {d.hasPlan ? `${planCount(d.acceptedBlocks, 'accepted block')}` : 'No plan'}
                </span>
                <span>
                  {d.busyEvents === null
                    ? 'Calendar not connected'
                    : planCount(d.busyEvents, 'busy event')}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  )
}
