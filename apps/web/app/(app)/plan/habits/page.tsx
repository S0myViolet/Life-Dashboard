import { Suspense } from 'react'
import { PageHeader } from '@/components/shell/app-shell'
import { HabitBoard } from '@/components/habits/habit-board'
import { PlanTabs } from '@/components/tasks/plan-tabs'
import { SectionBoundary, SectionSkeleton } from '@/components/tasks/section-boundary'
import { requireOwner, withOwnerTx } from '@/lib/server/session'
import { loadHabits } from '@/lib/tasks/view'

export const metadata = { title: 'Habits' }

async function HabitsSection() {
  const data = await withOwnerTx((tx) => loadHabits(tx, new Date()))
  return (
    <>
      <p className="mb-3 text-sm text-ink-muted">
        Days follow your timezone, <span className="text-ink">{data.tz}</span>.
      </p>
      <HabitBoard data={data} />
    </>
  )
}

export default async function HabitsPage() {
  await requireOwner()
  return (
    <>
      <PageHeader title="Habits" subtitle="Check off today and see how the last weeks went." />
      <PlanTabs current="habits" />
      <div className="max-w-3xl">
        <SectionBoundary title="Habits">
          <Suspense fallback={<SectionSkeleton label="Loading habits…" />}>
            <HabitsSection />
          </Suspense>
        </SectionBoundary>
      </div>
    </>
  )
}
