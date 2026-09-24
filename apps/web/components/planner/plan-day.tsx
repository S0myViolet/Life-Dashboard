/**
 * Async loader for the Day view: wrap it in <Suspense> so the page shell renders first.
 * A failure shows an honest "could not load" state instead of an empty plan.
 */
import { unstable_rethrow } from 'next/navigation'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { loadPlanDay } from '@/lib/planner/server'
import type { PlanDayView } from '@/lib/planner/view'
import { DayView } from './day-view'

export async function PlanDay({ date }: { date?: string }) {
  let view: PlanDayView
  try {
    view = await loadPlanDay(date)
  } catch (error) {
    unstable_rethrow(error)
    console.error(
      '[planner] could not load the day view:',
      error instanceof Error ? error.message : 'unknown error',
    )
    return (
      <Card>
        <EmptyState title="Your plan could not be loaded.">
          Nothing was changed. Try again in a moment.
        </EmptyState>
      </Card>
    )
  }
  return <DayView view={view} />
}
