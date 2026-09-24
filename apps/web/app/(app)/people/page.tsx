import { PageHeader } from '@/components/shell/app-shell'
import { PlannedSection } from '@/components/ui/planned-section'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'People' }

export default async function Page() {
  await requireOwner()
  return (
    <>
      <PageHeader title="People" />
      <PlannedSection milestone="Milestone 1">
        <p>People you keep in touch with, their important dates and catch-up reminders.</p>
      </PlannedSection>
    </>
  )
}
