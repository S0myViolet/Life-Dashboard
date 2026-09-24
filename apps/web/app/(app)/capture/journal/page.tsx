import { requireOwner } from '@/lib/server/session'
import { JournalView } from './journal-view'

export const metadata = { title: 'Journal' }

export default async function JournalTodayPage() {
  await requireOwner()
  return <JournalView date={null} />
}
