'use client'
/**
 * "Plan my day" / "Replan remaining day" and "Accept all". Replanning only uses time from now
 * on and never changes accepted, pinned, done or edited items.
 */
import { useActionState } from 'react'
import { CheckCheck, RefreshCw } from 'lucide-react'
import { buttonClass } from '@/components/ui/button'
import { acceptAllAction, replanDayAction, type PlanActionState } from '@/lib/planner/actions'

export function PlanToolbar({
  localDate,
  exists,
  relative,
  acceptable,
}: {
  localDate: string
  exists: boolean
  relative: 'today' | 'tomorrow'
  /** Confirmed, current suggestions that "Accept all" would accept. */
  acceptable: number
}) {
  const [replan, replanAction, replanning] = useActionState<PlanActionState | null, FormData>(
    replanDayAction,
    null,
  )
  const [accept, acceptAction, accepting] = useActionState<PlanActionState | null, FormData>(
    acceptAllAction,
    null,
  )
  const label = !exists
    ? relative === 'today'
      ? 'Plan my day'
      : 'Plan tomorrow'
    : relative === 'today'
      ? 'Replan remaining day'
      : 'Replan tomorrow'
  const latest = [replan, accept]
    .filter((s): s is PlanActionState => s !== null)
    .sort((a, b) => b.seq - a.seq)[0]

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <form action={replanAction}>
          <input type="hidden" name="localDate" value={localDate} />
          <button type="submit" className={buttonClass('primary')} disabled={replanning}>
            <RefreshCw aria-hidden className={`size-4 ${replanning ? 'animate-spin' : ''}`} />
            {replanning ? 'Planning…' : label}
          </button>
        </form>
        {exists && acceptable > 0 ? (
          <form action={acceptAction}>
            <input type="hidden" name="localDate" value={localDate} />
            <button type="submit" className={buttonClass('secondary')} disabled={accepting}>
              <CheckCheck aria-hidden className="size-4" />
              Accept all suggestions
            </button>
          </form>
        ) : null}
      </div>
      <p aria-live="polite" className="text-sm empty:hidden">
        {latest?.message ? (
          <span className={latest.ok ? 'text-positive' : 'text-danger'}>{latest.message}</span>
        ) : null}
      </p>
    </div>
  )
}
