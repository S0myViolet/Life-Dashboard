'use client'

/** "Replan remaining day" from Home, through the planner's own server action. */
import { useActionState } from 'react'
import { RefreshCw } from 'lucide-react'
import { buttonClass } from '@/components/ui/button'
import { replanDayAction, type PlanActionState } from '@/lib/planner/actions'

export function ReplanButton({ localDate }: { localDate: string }) {
  const [state, action, pending] = useActionState<PlanActionState | null, FormData>(
    replanDayAction,
    null,
  )
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="localDate" value={localDate} />
      <button type="submit" className={buttonClass('primary', 'px-3')} disabled={pending}>
        <RefreshCw aria-hidden className={`size-4 ${pending ? 'animate-spin' : ''}`} />
        {pending ? 'Planning…' : 'Replan remaining day'}
      </button>
      <p aria-live="polite" className="text-sm empty:hidden">
        {state?.message ? (
          <span className={state.ok ? 'text-positive' : 'text-danger'}>{state.message}</span>
        ) : null}
      </p>
    </form>
  )
}
