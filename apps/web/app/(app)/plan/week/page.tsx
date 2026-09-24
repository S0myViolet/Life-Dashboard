import { Suspense } from 'react'
import { PageHeader } from '@/components/shell/app-shell'
import { PlanDaySkeleton } from '@/components/planner/day-view'
import { PlanTabs } from '@/components/planner/plan-tabs'
import { PlanWeek } from '@/components/planner/week-view'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Plan · Week' }

export default async function PlanWeekPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireOwner()
  const { start } = await searchParams
  const startDate = typeof start === 'string' ? start : undefined
  return (
    <>
      <PageHeader title="Plan" subtitle="The week at a glance. Open a day to see its plan." />
      <PlanTabs active="week" />
      <Suspense key={startDate ?? 'current'} fallback={<PlanDaySkeleton />}>
        <PlanWeek start={startDate} />
      </Suspense>
    </>
  )
}
