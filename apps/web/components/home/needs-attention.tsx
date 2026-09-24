/**
 * Home module 1, "Needs attention": overdue tasks, timed tasks due within 24 hours, due
 * reminders, important dates inside their reminder window and catch-ups that are due. Every
 * item links to its source. The footer always names the sources that were checked and the ones
 * that are not connected yet, so an empty list is never read as "all clear".
 */
import Link from 'next/link'
import type { OwnerSettings } from '@personal-home/db'
import { Pill } from '@/components/ui/status-pill'
import { HOME_MODULE_LABELS } from '@personal-home/core'
import { homeTimeZone, loadHomeAttention } from './data'
import { ModuleCard, TimezoneUnusable, homeLinkClass } from './module-card'
import type { HomeAttentionItem } from './view'

export async function NeedsAttentionModule({ settings }: { settings: OwnerSettings }) {
  const tz = homeTimeZone(settings)
  const title = HOME_MODULE_LABELS.needs_attention
  if (!tz) {
    return (
      <ModuleCard id="needs-attention" title={title} wide>
        <TimezoneUnusable what="due dates and reminders" />
        <NotConnectedNote />
      </ModuleCard>
    )
  }
  const view = await loadHomeAttention(new Date(), tz)
  const { items, sources, more } = view
  const bothFailed = !sources.tasks && !sources.people
  const count = items.length + more.tasks + more.people

  return (
    <ModuleCard
      id="needs-attention"
      title={title}
      status={count > 0 ? <Pill tone="caution">{count}</Pill> : null}
      href="/plan/tasks"
      hrefLabel="Tasks"
      wide
    >
      {bothFailed ? (
        <p role="alert" className="text-danger">
          Your tasks, reminders and people could not be loaded right now, so this list may be
          missing items. Reload to try again.
        </p>
      ) : (
        <>
          {!sources.tasks ? (
            <p role="alert" className="text-danger">
              Tasks and reminders could not be loaded right now; overdue and due-soon items may be
              missing.
            </p>
          ) : null}
          {!sources.people ? (
            <p role="alert" className="text-danger">
              People could not be loaded right now; birthdays and catch-ups may be missing.
            </p>
          ) : null}
          {items.length > 0 ? (
            <ul className="divide-y divide-line" data-testid="attention-list">
              {items.map((item) => (
                <AttentionRow key={item.key} item={item} />
              ))}
            </ul>
          ) : sources.tasks && sources.people ? (
            <p data-testid="attention-empty">
              Nothing in your tasks or reminders is overdue or due in the next 24 hours, and no
              birthdays or catch-ups are due.
            </p>
          ) : null}
          {more.tasks > 0 || more.people > 0 ? (
            <p className="flex flex-wrap gap-x-4">
              {more.tasks > 0 ? (
                <Link href="/plan/tasks" className={homeLinkClass}>
                  {more.tasks} more in Tasks
                </Link>
              ) : null}
              {more.people > 0 ? (
                <Link href="/people" className={homeLinkClass}>
                  {more.people} more in People
                </Link>
              ) : null}
            </p>
          ) : null}
        </>
      )}
      <NotConnectedNote />
    </ModuleCard>
  )
}

const TONE: Record<HomeAttentionItem['tone'], 'danger' | 'caution' | 'accent' | 'neutral'> = {
  danger: 'danger',
  caution: 'caution',
  accent: 'accent',
  neutral: 'neutral',
}

function AttentionRow({ item }: { item: HomeAttentionItem }) {
  return (
    <li className="py-1.5" data-kind={item.kind}>
      <Link
        href={item.href}
        className="group flex min-h-11 flex-col justify-center rounded-lg px-1 py-1 hover:bg-surface-muted"
      >
        <span className="break-words font-medium text-ink group-hover:text-accent-strong">
          {item.title}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-muted">
          <Pill tone={TONE[item.tone]}>{item.label}</Pill>
          <span>{item.detail}</span>
        </span>
      </Link>
    </li>
  )
}

/** Always shown: which sources are not feeding this list yet. */
function NotConnectedNote() {
  return (
    <p className="border-t border-line pt-3 text-xs text-ink-muted" data-testid="attention-sources">
      Checked your tasks, reminders and people. Deadlines from email and calendars are not connected
      yet (Milestone 2), so this list is not a full all-clear.{' '}
      <Link
        href="/settings/connections"
        className="inline-flex min-h-11 items-center font-medium text-accent hover:text-accent-strong sm:min-h-0"
      >
        Connections
      </Link>
    </p>
  )
}
