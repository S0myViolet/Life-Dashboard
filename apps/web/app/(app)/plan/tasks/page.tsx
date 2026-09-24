import { Suspense } from 'react'
import { PageHeader } from '@/components/shell/app-shell'
import { ReminderList } from '@/components/reminders/reminder-list'
import { PlanTabs } from '@/components/tasks/plan-tabs'
import { SectionBoundary, SectionSkeleton } from '@/components/tasks/section-boundary'
import { TaskBoard } from '@/components/tasks/task-board'
import { requireOwner, withOwnerTx } from '@/lib/server/session'
import { loadReminders, loadTaskBoard } from '@/lib/tasks/view'

export const metadata = { title: 'Tasks' }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function TasksSection({ initialEditId }: { initialEditId: string | null }) {
  const data = await withOwnerTx((tx) => loadTaskBoard(tx, new Date()))
  return (
    <>
      <p className="mb-3 text-sm text-ink-muted">
        Dates and times are in <span className="text-ink">{data.tz}</span>.
      </p>
      <TaskBoard data={data} initialEditId={initialEditId} />
    </>
  )
}

async function RemindersSection() {
  const data = await withOwnerTx((tx) => loadReminders(tx, new Date()))
  return <ReminderList data={data} />
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireOwner()
  const { task } = await searchParams
  const initialEditId = typeof task === 'string' && UUID_RE.test(task) ? task : null

  return (
    <>
      <PageHeader title="Tasks" subtitle="Your local tasks and reminders." />
      <PlanTabs current="tasks" />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <SectionBoundary title="Tasks">
            <Suspense fallback={<SectionSkeleton label="Loading tasks…" />}>
              <TasksSection initialEditId={initialEditId} />
            </Suspense>
          </SectionBoundary>
        </div>
        <div className="min-w-0 lg:sticky lg:top-6">
          <SectionBoundary title="Reminders">
            <Suspense fallback={<SectionSkeleton label="Loading reminders…" />}>
              <RemindersSection />
            </Suspense>
          </SectionBoundary>
        </div>
      </div>
    </>
  )
}
