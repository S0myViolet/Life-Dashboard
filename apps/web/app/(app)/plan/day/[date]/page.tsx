import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { CalendarDateSchema } from '@personal-home/core'
import { PageHeader } from '@/components/shell/app-shell'
import { PlanDaySkeleton } from '@/components/planner/day-view'
import { PlanDay } from '@/components/planner/plan-day'
import { PlanTabs } from '@/components/planner/plan-tabs'
import { planLongDateLabel } from '@/lib/planner/view'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Plan · Day' }

/** A specific day's plan. Past days are read-only; tomorrow can be drafted on request. */
export default async function PlanDayPage({ params }: { params: Promise<{ date: string }> }) {
  await requireOwner()
  const { date } = await params
  const parsed = CalendarDateSchema.safeParse(date)
  if (!parsed.success) notFound()
  return (
    <>
      <PageHeader title="Plan" subtitle={planLongDateLabel(parsed.data)} />
      <PlanTabs active="day" />
      <Suspense key={parsed.data} fallback={<PlanDaySkeleton />}>
        <PlanDay date={parsed.data} />
      </Suspense>
    </>
  )
}
