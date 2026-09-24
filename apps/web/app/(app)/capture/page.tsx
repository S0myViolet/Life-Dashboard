import { PageHeader } from '@/components/shell/app-shell'
import { PlannedSection } from '@/components/ui/planned-section'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Capture' }

export default async function Page() {
  await requireOwner()
  return (
    <>
      <PageHeader title="Capture" />
      <PlannedSection milestone="Milestone 1">
        <p>Searchable notes and a voice or text journal.</p>
      </PlannedSection>
    </>
  )
}
