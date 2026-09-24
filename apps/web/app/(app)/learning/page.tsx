import { PageHeader } from '@/components/shell/app-shell'
import { PlannedSection } from '@/components/ui/planned-section'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Learning' }

export default async function Page() {
  await requireOwner()
  return (
    <>
      <PageHeader title="Learning" />
      <PlannedSection milestone="Milestone 1">
        <p>Reading list, reading progress, learning goals and practice habits.</p>
      </PlannedSection>
    </>
  )
}
