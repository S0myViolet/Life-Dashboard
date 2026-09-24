import { PageHeader } from '@/components/shell/app-shell'
import { PlannedSection } from '@/components/ui/planned-section'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Settings' }

export default async function Page() {
  await requireOwner()
  return (
    <>
      <PageHeader title="Settings" />
      <PlannedSection milestone="Milestone 0">
        <p>Timezone, connected accounts, notifications, data export and budget.</p>
      </PlannedSection>
    </>
  )
}
