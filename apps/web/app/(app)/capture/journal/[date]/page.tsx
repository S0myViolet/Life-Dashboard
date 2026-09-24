import { notFound } from 'next/navigation'
import { CalendarDateSchema } from '@personal-home/core'
import { requireOwner } from '@/lib/server/session'
import { JournalView } from '../journal-view'

export const metadata = { title: 'Journal' }

export default async function JournalDatePage({ params }: { params: Promise<{ date: string }> }) {
  await requireOwner()
  const parsed = CalendarDateSchema.safeParse((await params).date)
  if (!parsed.success) notFound()
  return <JournalView date={parsed.data} />
}
