import { PageHeader } from '@/components/shell/app-shell'
import { PlannedSection } from '@/components/ui/planned-section'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Plan' }

export default async function Page() {
  await requireOwner()
  return (
    <>
      <PageHeader title="Plan" />
      <PlannedSection milestone="Milestone 1">
        <p>Day and week calendar, local tasks, habits and the daily plan.</p>
      </PlannedSection>
    </>
  )
}
