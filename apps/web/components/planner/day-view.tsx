/**
 * The Day view of the Plan page (server component). Shows priorities with reasons, the
 * timeline (busy events read-only + plan blocks), small tasks, list mode, Can wait, Does not
 * fit and an honest capacity summary. Owner actions live in <PlanBlock> and <PlanToolbar>.
 */
import Link from 'next/link'
import { AlertTriangle, CalendarOff, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { plannerDurationLabel, type PlanUnplacedItem } from '@personal-home/core'
import { Card, CardHeader } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Pill } from '@/components/ui/status-pill'
import { PLAN_KIND_LABELS, planMinutesLabel, type PlanDayView } from '@/lib/planner/view'
import { PlanBlock } from './plan-block'
import { PlanToolbar } from './plan-toolbar'

function dayHref(localDate: string, relative: PlanDayView['relative'] | 'other') {
  return relative === 'today' ? '/plan' : `/plan/day/${localDate}`
}

export function PlanDayNav({ view }: { view: PlanDayView }) {
  const link =
    'inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm text-accent hover:bg-surface-muted hover:text-accent-strong'
  return (
    <nav aria-label="Change day" className="mb-4 flex items-center justify-between gap-2">
      <Link href={dayHref(view.prevDate, 'other')} className={link}>
        <ChevronLeft aria-hidden className="size-4" /> Previous day
      </Link>
      <p className="text-center text-sm font-medium text-ink">
        {view.dateLabel}
        {view.relative === 'today' ? <span className="text-ink-muted"> · Today</span> : null}
        {view.relative === 'tomorrow' ? <span className="text-ink-muted"> · Tomorrow</span> : null}
      </p>
      <Link href={dayHref(view.nextDate, 'other')} className={link}>
        Next day <ChevronRight aria-hidden className="size-4" />
      </Link>
    </nav>
  )
}

function UnplacedList({ items, id }: { items: PlanUnplacedItem[]; id: string }) {
  return (
    <ul className="divide-y divide-line" aria-labelledby={id}>
      {items.map((item) => (
        <li
          key={`${item.candidateKind}:${item.candidateId}`}
          className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2"
        >
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">
              {item.title} {item.tentative ? <Pill tone="tentative">Tentative</Pill> : null}
              {item.priorityRank ? <Pill tone="accent">Priority {item.priorityRank}</Pill> : null}
            </p>
            <p className="text-xs text-ink-muted">
              {PLAN_KIND_LABELS[item.candidateKind]} ·{' '}
              {planMinutesLabel(item.minutes, item.estimated)}
            </p>
          </div>
          <p className="text-xs text-ink-muted">{item.reason}</p>
        </li>
      ))}
    </ul>
  )
}

function CapacitySummary({ view }: { view: PlanDayView }) {
  const c = view.capacity
  if (!c) return null
  if (!c.known) {
    return (
      <Card aria-labelledby="plan-capacity">
        <CardHeader title="Capacity" id="plan-capacity" />
        <p className="text-sm text-ink-muted">
          Total estimated effort:{' '}
          <strong className="text-ink">{plannerDurationLabel(c.demandMinutes)}</strong>. Free time
          is unknown without available hours, so this list does not say what fits.
        </p>
        <p className="mt-2 text-sm">
          <Link href="/settings" className="text-accent underline-offset-2 hover:underline">
            Set available hours in Settings
          </Link>{' '}
          <span className="text-ink-muted">to plan with times.</span>
        </p>
      </Card>
    )
  }
  const rows: Array<[string, number | null]> = [
    ['Free time left', c.freeMinutes],
    ['Kept free (about 20%)', c.bufferMinutes],
    ['Suggested', c.allocatedMinutes],
    ['Not placed', c.overflowMinutes],
  ]
  return (
    <Card aria-labelledby="plan-capacity">
      <CardHeader title="Capacity" id="plan-capacity" />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        {rows.map(([label, minutes]) => (
          <div key={label}>
            <dt className="text-xs text-ink-muted">{label}</dt>
            <dd className="font-medium tabular-nums text-ink">
              {minutes === null ? '—' : plannerDurationLabel(minutes)}
            </dd>
          </div>
        ))}
      </dl>
      {c.overflowMinutes ? (
        <p className="mt-3 text-sm text-caution">
          Not everything fits today: {plannerDurationLabel(c.overflowMinutes)} of work is left over.
        </p>
      ) : null}
    </Card>
  )
}

export function DayView({ view }: { view: PlanDayView }) {
  const editable = view.canPlan
  const toolbar = editable ? (
    <PlanToolbar
      localDate={view.localDate}
      exists={view.exists}
      relative={view.relative as 'today' | 'tomorrow'}
      acceptable={view.counts.suggested}
    />
  ) : null

  if (!view.exists) {
    return (
      <div className="space-y-4">
        <PlanDayNav view={view} />
        <Card>
          {view.relative === 'past' ? (
            <EmptyState title="No plan was made for this day." />
          ) : view.relative === 'future' ? (
            <EmptyState title="Plans are drafted for today and tomorrow.">
              Come back closer to the day, or add due dates to tasks so they are ready.
            </EmptyState>
          ) : (
            <EmptyState title="No plan yet for this day." action={toolbar} />
          )}
        </Card>
      </div>
    )
  }

  const timeMode = view.mode === 'time'
  const hasAnything =
    view.timeline.length + view.smallTasks.length + view.list.length + view.priorities.length > 0

  return (
    <div className="space-y-4">
      <PlanDayNav view={view} />

      {toolbar ? <div>{toolbar}</div> : null}

      <p className="text-xs text-ink-faint">
        {view.generatedLabel} · Times in {view.timezone}
        {view.readOnly ? ' · Past day (read-only)' : ''}
      </p>

      {view.conflicts.length > 0 ? (
        <div
          role="alert"
          className="rounded-xl border border-danger/30 bg-danger-soft p-3 text-sm text-danger"
        >
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle aria-hidden className="size-4" /> Conflicts need your decision
          </p>
          <ul className="mt-1 list-disc pl-5">
            {view.conflicts.map((c) => (
              <li key={`${c.kind}-${c.blockId}-${c.withId}`}>
                {c.blockTitle ? `“${c.blockTitle}”: ` : ''}
                {c.message}. Nothing was moved automatically.
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {view.changes ? (
        <div
          className="rounded-xl border border-accent/30 bg-accent-soft p-3 text-sm text-ink"
          data-testid="plan-changes"
        >
          Your tasks or the time left have changed since this plan was drafted
          {view.changes.additions ? ` (${view.changes.additions} new)` : ''}
          {view.changes.removals ? ` (${view.changes.removals} no longer fit or needed)` : ''}.
          Replan to update the suggestions; accepted, pinned and edited items stay as they are.
        </div>
      ) : null}

      {view.notes.length > 0 ? (
        <ul className="space-y-1 text-sm text-ink-muted">
          {view.notes.map((n) => (
            <li key={n.code}>
              {n.message}
              {n.code.startsWith('list_mode') ? (
                <>
                  {' '}
                  <Link href="/settings" className="text-accent underline-offset-2 hover:underline">
                    Set available hours in Settings
                  </Link>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <Card aria-labelledby="plan-priorities">
        <CardHeader title="Priorities" id="plan-priorities" meta="Up to three" />
        {view.priorities.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Nothing is overdue, due soon or marked high priority, so no priorities were picked.
          </p>
        ) : (
          <ol className="space-y-2" data-testid="plan-priorities">
            {view.priorities.map((p) => (
              <li key={p.rank} className="flex items-start gap-3">
                <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-strong">
                  {p.rank}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{p.title}</p>
                  <p className="text-xs text-ink-muted">
                    {p.reason}
                    {p.timeLabel ? ` · ${p.timeLabel}` : ''}
                    {p.state === 'done' ? ' · Done' : ''}
                    {p.state === 'does_not_fit' ? ' · Does not fit today' : ''}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {timeMode ? (
        <Card aria-labelledby="plan-timeline">
          <CardHeader title="Timeline" id="plan-timeline" />
          <p className="mb-3 flex items-start gap-2 text-xs text-ink-muted">
            <CalendarOff aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>
              {view.calendar.message}{' '}
              <Link href="/settings" className="text-accent underline-offset-2 hover:underline">
                Connections
              </Link>
            </span>
          </p>
          {view.timeline.length === 0 ? (
            <p className="text-sm text-ink-muted">
              {hasAnything ? 'No timed blocks.' : 'Nothing is planned for this day.'}
            </p>
          ) : (
            <ol className="space-y-2" data-testid="plan-timeline">
              {view.timeline.map((entry) =>
                entry.type === 'event' ? (
                  <li
                    key={`e-${entry.event.id}`}
                    className="rounded-xl border border-line bg-surface-muted px-3 py-3 text-sm"
                  >
                    <p className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-mono tabular-nums text-ink-muted">
                        {entry.event.timeLabel}
                      </span>
                      <span className="font-medium text-ink">{entry.event.title}</span>
                      <Pill>Busy · {entry.event.source}</Pill>
                    </p>
                    {entry.event.url ? (
                      <a
                        href={entry.event.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-flex min-h-11 items-center gap-1 text-xs text-accent sm:min-h-0"
                      >
                        Open in {entry.event.source} <ExternalLink aria-hidden className="size-3" />
                      </a>
                    ) : null}
                  </li>
                ) : (
                  <PlanBlock key={entry.block.id} block={entry.block} />
                ),
              )}
            </ol>
          )}
        </Card>
      ) : (
        <Card aria-labelledby="plan-list">
          <CardHeader
            title="Suggested order"
            id="plan-list"
            meta={
              view.capacity
                ? `Total ${plannerDurationLabel(view.capacity.demandMinutes)}`
                : undefined
            }
          />
          {view.list.length === 0 ? (
            <p className="text-sm text-ink-muted">
              Nothing to plan: no open tasks, due habits or reading goals.
            </p>
          ) : (
            <ol className="space-y-2" data-testid="plan-list">
              {view.list.map((b) => (
                <PlanBlock key={b.id} block={b} showTime={false} />
              ))}
            </ol>
          )}
        </Card>
      )}

      {view.smallTasks.length > 0 ? (
        <Card aria-labelledby="plan-small">
          <CardHeader title="Small tasks for short gaps" id="plan-small" />
          <ol className="space-y-2" data-testid="plan-small">
            {view.smallTasks.map((b) => (
              <PlanBlock key={b.id} block={b} />
            ))}
          </ol>
        </Card>
      ) : null}

      {view.doesNotFit.length > 0 ? (
        <Card aria-labelledby="plan-does-not-fit">
          <CardHeader
            title="Does not fit"
            id="plan-does-not-fit"
            meta={`${view.doesNotFit.length}`}
          />
          <UnplacedList items={view.doesNotFit} id="plan-does-not-fit" />
        </Card>
      ) : null}

      {view.canWait.length > 0 ? (
        <Card aria-labelledby="plan-can-wait">
          <CardHeader title="Can wait" id="plan-can-wait" meta={`${view.canWait.length}`} />
          <UnplacedList items={view.canWait} id="plan-can-wait" />
        </Card>
      ) : null}

      <CapacitySummary view={view} />

      {view.dismissed.length > 0 ? (
        <details className="rounded-xl border border-line bg-surface px-4 py-2">
          <summary className="min-h-11 cursor-pointer py-2 text-sm text-ink-muted">
            Dismissed ({view.dismissed.length})
          </summary>
          <ol className="space-y-2 pb-2">
            {view.dismissed.map((b) => (
              <PlanBlock key={b.id} block={b} />
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  )
}

export function PlanDaySkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-4">
      <p className="sr-only">Loading your plan…</p>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-28 animate-pulse rounded-[var(--radius-card)] border border-line bg-surface"
        />
      ))}
    </div>
  )
}
