import { PageHeader } from '@/components/shell/app-shell'
import { PlannedSection } from '@/components/ui/planned-section'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Money' }

export default async function Page() {
  await requireOwner()
  return (
    <>
      <PageHeader title="Money" />
      <PlannedSection milestone="Milestone 3">
        <p>Balances in their original currency, recent transactions and subscription candidates.</p>
      </PlannedSection>
    </>
  )
}
