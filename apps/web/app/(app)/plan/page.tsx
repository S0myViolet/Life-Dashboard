import { Suspense } from 'react'
import { PageHeader } from '@/components/shell/app-shell'
import { PlanDaySkeleton } from '@/components/planner/day-view'
import { PlanDay } from '@/components/planner/plan-day'
import { PlanTabs } from '@/components/planner/plan-tabs'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Plan' }

/** Today's plan. Drafted from saved data on first use each local day. */
export default async function PlanPage() {
  await requireOwner()
  return (
    <>
      <PageHeader
        title="Plan"
        subtitle="Today's priorities and a suggested schedule. Nothing is final until you accept it."
      />
      <PlanTabs active="day" />
      <Suspense fallback={<PlanDaySkeleton />}>
        <PlanDay />
      </Suspense>
    </>
  )
}
