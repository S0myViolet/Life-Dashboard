import { PageHeader } from '@/components/shell/app-shell'
import { PlannedSection } from '@/components/ui/planned-section'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Updates' }

export default async function Page() {
  await requireOwner()
  return (
    <>
      <PageHeader title="Updates" />
      <PlannedSection milestone="Milestone 3">
        <p>
          Financial news, Markets, AI updates, Liverpool, Premier League, Champions League and
          Music.
        </p>
      </PlannedSection>
    </>
  )
}
