/**
 * Home module 2, "Your plan for today": up to three priorities with their reasons and the
 * next suggested action, with a link to the full plan. A server component with no props that
 * reads its own data (owner transaction); it drafts today's plan on first use. Place it inside
 * its own <Suspense> so Home never waits on it.
 */
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { unstable_rethrow } from 'next/navigation'
import { Card, CardHeader } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Pill } from '@/components/ui/status-pill'
import { loadTodaysPlanCard, type TodaysPlanCardData } from '@/lib/planner/server'

export async function TodaysPlanCard() {
  let data: TodaysPlanCardData
  try {
    data = await loadTodaysPlanCard()
  } catch (error) {
    unstable_rethrow(error)
    console.error(
      '[planner] could not load the Home plan card:',
      error instanceof Error ? error.message : 'unknown error',
    )
    return (
      <Card aria-labelledby="home-plan">
        <CardHeader title="Your plan for today" id="home-plan" href="/plan" hrefLabel="Open plan" />
        <p className="text-sm text-ink-muted">Your plan could not be loaded right now.</p>
      </Card>
    )
  }
  const { view } = data
  const next = view.nextAction
  return (
    <Card aria-labelledby="home-plan" data-testid="todays-plan-card">
      <CardHeader title="Your plan for today" id="home-plan" href="/plan" hrefLabel="Open plan" />
      {view.priorities.length === 0 && !next ? (
        <EmptyState title="Nothing pressing today.">
          No overdue items, deadlines or high priorities.{' '}
          <Link href="/plan" className="text-accent underline-offset-2 hover:underline">
            See the plan
          </Link>
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {view.priorities.length > 0 ? (
            <ol className="space-y-2">
              {view.priorities.slice(0, 3).map((p) => (
                <li key={p.rank} className="flex items-start gap-3">
                  <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-strong">
                    {p.rank}
                  </span>
                  <div className="min-w-0">
                    <p
                      className={`text-sm font-medium ${p.state === 'done' ? 'text-ink-muted line-through' : 'text-ink'}`}
                    >
                      {p.title}
                    </p>
                    <p className="text-xs text-ink-muted">{p.reason}</p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-ink-muted">
              No priorities: nothing is overdue, due soon or marked high priority.
            </p>
          )}
          {next ? (
            <div className="rounded-xl border border-line bg-surface-muted/60 px-3 py-2">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                {next.isNow ? 'Now' : 'Next'}
              </p>
              <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-sm text-ink">
                {next.timeLabel ? (
                  <span className="font-mono tabular-nums text-ink-muted">{next.timeLabel}</span>
                ) : null}
                <span className="font-medium">{next.title}</span>
                <span className="text-xs text-ink-muted">{next.durationLabel}</span>
                {next.tentative ? <Pill tone="tentative">Tentative</Pill> : null}
                {next.state === 'suggested' ? <Pill>Suggested</Pill> : null}
              </p>
            </div>
          ) : null}
          {view.mode === 'list' ? (
            <p className="text-xs text-ink-muted">
              No available hours set, so this is an ordered list without times.
            </p>
          ) : null}
          <Link
            href="/plan"
            className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-accent hover:text-accent-strong"
          >
            Review and accept today&apos;s plan <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>
      )}
    </Card>
  )
}

export default TodaysPlanCard
