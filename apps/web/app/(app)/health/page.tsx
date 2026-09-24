import { PageHeader } from '@/components/shell/app-shell'
import { PlannedSection } from '@/components/ui/planned-section'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Health' }

export default async function Page() {
  await requireOwner()
  return (
    <>
      <PageHeader title="Health" />
      <PlannedSection milestone="Milestone 3">
        <p>WHOOP sleep, recovery, strain and workouts, with source freshness.</p>
      </PlannedSection>
    </>
  )
}
