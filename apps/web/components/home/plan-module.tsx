/**
 * Home module 2, "Your plan for today": the planner's own card (it drafts today's plan on first
 * use), followed by two Home notes:
 *   - when tasks changed since the plan was drafted, a proposed revision with a Replan button
 *     (brief §3: later changes produce a proposal, never a silent replacement);
 *   - the available hours the planner works with, or that none are set.
 * The notice loads in its own Suspense boundary so it never holds up the card.
 */
import Link from 'next/link'
import { Suspense } from 'react'
import { unstable_rethrow } from 'next/navigation'
import { localDateInZone, summarizeAvailableHours } from '@personal-home/core'
import { plannerPreviewRevision, type OwnerSettings } from '@personal-home/db'
import { TodaysPlanCard } from '@/components/planner/todays-plan-card'
import { withOwnerTx } from '@/lib/server/session'
import { homeTimeZone } from './data'
import { homeLinkClass } from './module-card'
import { ReplanButton } from './replan-button'

export function PlanModule({ settings }: { settings: OwnerSettings }) {
  const hours = summarizeAvailableHours(settings.availableHours)
  return (
    // On phones every link in the module is a 44px touch target, including the planner card's
    // header link (the shared CardHeader link is ~24px tall).
    <div
      data-home-module="todays-plan"
      className="space-y-2 lg:col-span-2 max-sm:[&_a]:inline-flex max-sm:[&_a]:min-h-11 max-sm:[&_a]:items-center"
    >
      <TodaysPlanCard />
      <Suspense fallback={null}>
        <PlanChangesNotice settings={settings} />
      </Suspense>
      <div
        className="flex flex-wrap items-center gap-x-2 px-1 text-xs text-ink-muted"
        data-testid="plan-hours"
      >
        {settings.availableHoursInvalid ? (
          <p className="text-caution">
            Your saved available hours could not be read. Set them again so the planner can use
            them.
          </p>
        ) : hours ? (
          <p>Planning around your available hours: {hours}.</p>
        ) : (
          <p>No available hours are set, so the plan has no times.</p>
        )}
        <Link href="/settings/hours" className={homeLinkClass}>
          {hours ? 'Change hours' : 'Set available hours'}
        </Link>
      </div>
    </div>
  )
}

async function PlanChangesNotice({ settings }: { settings: OwnerSettings }) {
  const tz = homeTimeZone(settings)
  if (!tz) return null
  const now = new Date()
  const today = localDateInZone(now, tz)
  let changes: { additions: number; removals: number } | null = null
  try {
    const revision = await withOwnerTx((tx) =>
      plannerPreviewRevision(tx, { now, localDate: today }),
    )
    // New or finished tasks count as changes; suggestions that merely moved because time
    // passed do not (Plan shows those when the owner opens it).
    if (revision && revision.additions.length + revision.removals.length > 0) {
      changes = { additions: revision.additions.length, removals: revision.removals.length }
    }
  } catch (error) {
    unstable_rethrow(error)
    console.error('[home] could not check the plan for changes', {
      name: error instanceof Error ? error.name : typeof error,
    })
    return null
  }
  if (!changes) return null
  const parts = [
    changes.additions ? `${changes.additions} new` : null,
    changes.removals ? `${changes.removals} no longer needed` : null,
  ].filter(Boolean)
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-accent/30 bg-accent-soft px-3 py-2 text-sm text-ink"
      data-testid="home-plan-changes"
    >
      <p className="min-w-0 flex-1 basis-60">
        Your tasks changed since this plan was drafted ({parts.join(', ')}). Replanning keeps
        accepted, pinned and edited items as they are.
      </p>
      <ReplanButton localDate={today} />
    </div>
  )
}
