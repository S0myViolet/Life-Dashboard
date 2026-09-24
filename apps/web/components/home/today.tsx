/**
 * Home module 3, "Today": tasks due today and habits scheduled today, each checkable from here,
 * plus an honest calendar line (calendars arrive with the Milestone 2 connections).
 * Overdue tasks are listed in Needs attention, not here.
 */
import Link from 'next/link'
import { CalendarDays } from 'lucide-react'
import { HOME_MODULE_LABELS } from '@personal-home/core'
import type { OwnerSettings } from '@personal-home/db'
import { homeTimeZone, loadHomeToday } from './data'
import { ModuleCard, TimezoneUnusable, homeLinkClass } from './module-card'
import { TodayChecklist } from './today-checklist'

export async function TodayModule({ settings }: { settings: OwnerSettings }) {
  const tz = homeTimeZone(settings)
  const title = HOME_MODULE_LABELS.today
  if (!tz) {
    return (
      <ModuleCard id="today" title={title} href="/plan/week" hrefLabel="Week" wide>
        <TimezoneUnusable what="today’s tasks and habits" />
        <CalendarNote />
      </ModuleCard>
    )
  }
  const view = await loadHomeToday(new Date(), tz)
  return (
    <ModuleCard id="today" title={title} href="/plan/week" hrefLabel="Week" wide>
      <TodayChecklist today={view.today} tasks={view.tasks} habits={view.habits} />
      <CalendarNote />
    </ModuleCard>
  )
}

function CalendarNote() {
  return (
    <div className="flex items-start gap-2 border-t border-line pt-3 text-xs text-ink-muted">
      <CalendarDays aria-hidden className="mt-0.5 size-4 shrink-0" strokeWidth={1.8} />
      <p>
        Calendar events are not shown yet: Google and Outlook calendars arrive with the Milestone 2
        connections (read-only, with links back to the original).{' '}
        <Link href="/plan" className={homeLinkClass}>
          Today&rsquo;s plan
        </Link>
      </p>
    </div>
  )
}
