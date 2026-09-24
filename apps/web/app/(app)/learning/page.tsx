import { Suspense } from 'react'
import { PageHeader } from '@/components/shell/app-shell'
import { Card, CardHeader } from '@/components/ui/card'
import { BookForm } from '@/components/learning/book-form'
import { GoalsSection } from '@/components/learning/goals-section'
import { ReadingSections } from '@/components/learning/reading-sections'
import { SectionSkeleton } from '@/components/learning/section-skeleton'
import { TimeZoneNotice } from '@/components/learning/time-zone-notice'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Learning' }

export default async function LearningPage() {
  await requireOwner()
  return (
    <>
      <PageHeader
        title="Learning"
        subtitle="Your reading list, progress you log yourself, and learning goals."
      />
      <Suspense fallback={null}>
        <TimeZoneNotice />
      </Suspense>
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="min-w-0 space-y-4 lg:col-span-3">
          <Suspense fallback={<SectionSkeleton title="Reading now" />}>
            <ReadingSections />
          </Suspense>
        </div>
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Suspense fallback={<SectionSkeleton title="Learning goals" />}>
            <GoalsSection />
          </Suspense>
          <Card aria-labelledby="add-book-title">
            <CardHeader id="add-book-title" title="Add a book" />
            <BookForm idPrefix="new-book" />
          </Card>
        </div>
      </div>
    </>
  )
}
