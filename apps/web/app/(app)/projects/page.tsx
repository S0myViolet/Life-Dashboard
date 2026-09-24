import { PageHeader } from '@/components/shell/app-shell'
import { PlannedSection } from '@/components/ui/planned-section'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Projects' }

export default async function Page() {
  await requireOwner()
  return (
    <>
      <PageHeader title="Projects" />
      <PlannedSection milestone="Milestone 2">
        <p>Work and personal projects with linked ChatGPT and Claude conversations.</p>
      </PlannedSection>
    </>
  )
}
