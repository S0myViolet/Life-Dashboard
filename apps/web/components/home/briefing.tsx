/**
 * Home module 4, "Latest briefing": the most recent published briefing from public.briefings
 * with its publication time, a late label when it was published late, and how fresh its
 * sources were. Until one exists it says when the first one is due (and that briefings wait
 * for the timezone to be confirmed). Project changes arrive with Milestone 2 capture.
 */
import Link from 'next/link'
import { HOME_MODULE_LABELS } from '@personal-home/core'
import type { OwnerSettings } from '@personal-home/db'
import { DataStatePill, Pill } from '@/components/ui/status-pill'
import { homeTimeZone, loadHomeBriefing } from './data'
import { ModuleCard, TimezoneUnusable, homeLinkClass } from './module-card'

export async function BriefingModule({ settings }: { settings: OwnerSettings }) {
  const tz = homeTimeZone(settings)
  const title = HOME_MODULE_LABELS.briefing
  if (!tz) {
    return (
      <ModuleCard id="briefing" title={title}>
        <TimezoneUnusable what="briefing times" />
      </ModuleCard>
    )
  }
  const result = await loadHomeBriefing(new Date(), tz, settings.timezoneConfirmed)
  if (!result.ok) {
    return (
      <ModuleCard id="briefing" title={title} status={<DataStatePill state="unavailable" />}>
        <p role="alert" className="text-danger">
          Briefings could not be loaded right now. Reload to try again.
        </p>
      </ModuleCard>
    )
  }
  const view = result.data
  const latest = view.latest

  return (
    <ModuleCard
      id="briefing"
      title={title}
      status={
        latest ? (
          latest.late ? (
            <Pill tone="caution">Published late</Pill>
          ) : latest.stale ? (
            <DataStatePill state="stale" />
          ) : null
        ) : (
          <DataStatePill state="empty" />
        )
      }
    >
      {latest ? (
        <div className="space-y-2" data-testid="briefing-latest">
          <div>
            <p className="font-medium text-ink">
              {latest.title}{' '}
              <span className="font-normal text-ink-muted">· {latest.dateLabel}</span>
            </p>
            <p className="text-xs text-ink-muted">
              {latest.publishedLabel}
              {latest.late ? ` · ${latest.scheduledLabel.toLowerCase()}` : ''}
            </p>
          </div>
          {latest.readable ? (
            latest.summary ? (
              <p className="line-clamp-4">{latest.summary}</p>
            ) : null
          ) : (
            <p className="text-caution">This briefing&rsquo;s content could not be read.</p>
          )}
          {latest.sections.length > 0 ? (
            <details className="group">
              <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-accent hover:text-accent-strong sm:min-h-0">
                Sections ({latest.sections.length})
              </summary>
              <ul className="mt-1 space-y-1">
                {latest.sections.map((s) => (
                  <li key={s.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-ink">{s.title}</span>
                    <Pill>Planned · {s.availableIn}</Pill>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <p className="text-xs text-ink-muted">
            {latest.sourceCount === 0
              ? 'Sources read: none yet.'
              : `Sources read: ${latest.sourceCount}.`}
            {latest.sourceNote ? ` ${latest.sourceNote}` : ''}
          </p>
        </div>
      ) : view.timezoneConfirmed ? (
        <p data-testid="briefing-none">
          No briefing has been published yet. Briefings are scheduled for the {view.scheduleLabel},{' '}
          {settings.timezone}.
        </p>
      ) : (
        <p data-testid="briefing-none">
          No briefing yet. Your first briefing is published at 11:00 once your timezone is
          confirmed.{' '}
          <Link href="/settings/timezone" className={homeLinkClass}>
            Confirm timezone
          </Link>
        </p>
      )}
      {view.newerProblem ? <p className="text-caution">{view.newerProblem}</p> : null}
      {view.nextLabel ? <p className="text-xs text-ink-muted">{view.nextLabel}.</p> : null}
      <p className="text-xs text-ink-muted">
        Project changes from captured ChatGPT and Claude conversations will appear here with
        Milestone 2.
      </p>
    </ModuleCard>
  )
}
