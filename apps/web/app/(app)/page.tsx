import { PageHeader } from '@/components/shell/app-shell'
import { PlannedSection } from '@/components/ui/planned-section'
import { requireOwner } from '@/lib/server/session'

export default async function HomePage() {
  await requireOwner()
  return (
    <>
      <PageHeader title="Home" />
      <PlannedSection milestone="Milestone 0">
        <p>Home is being set up.</p>
      </PlannedSection>
    </>
  )
}
