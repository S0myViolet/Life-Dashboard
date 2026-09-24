/**
 * Home modules. Each is an async server component rendered inside its own
 * <Suspense> boundary, so a slow source never blocks the rest of Home.
 *
 * Milestone 0 has no data sources yet. Every module says plainly what will
 * appear, when, and what the owner can do now — never "all clear" or zeros.
 */
import Link from 'next/link'
import {
  HOME_MODULE_LABELS,
  INTEREST_SECTIONS,
  INTEREST_SECTION_LABELS,
  summarizeAvailableHours,
  type HomeModule,
} from '@personal-home/core'
import type { OwnerSettings } from '@personal-home/db'
import { DataStatePill, Pill } from '@/components/ui/status-pill'
import { ModuleCard, PlannedPill } from './module-card'

export interface HomeModuleProps {
  settings: OwnerSettings
}

const WIDE_MODULES: ReadonlySet<HomeModule> = new Set(['needs_attention', 'todays_plan', 'today'])

export function isWideHomeModule(module: HomeModule): boolean {
  return WIDE_MODULES.has(module)
}

const linkClass = 'inline-flex min-h-11 items-center font-medium text-accent hover:text-accent-strong sm:min-h-0'

async function NeedsAttention() {
  return (
    <ModuleCard
      id="needs-attention"
      title={HOME_MODULE_LABELS.needs_attention}
      status={<DataStatePill state="unavailable" />}
      wide
    >
      <p>Explicit deadlines, overdue tasks and time-sensitive messages will be listed here.</p>
      <p>
        Nothing is feeding this section yet, so an empty list here would not mean all clear. Local
        tasks arrive in Milestone 1; deadlines from connected Gmail and Outlook accounts in
        Milestone 2.
      </p>
      <Link href="/settings/connections" className={linkClass}>
        Review connections
      </Link>
    </ModuleCard>
  )
}

async function TodaysPlan({ settings }: HomeModuleProps) {
  const summary = summarizeAvailableHours(settings.availableHours)
  return (
    <ModuleCard
      id="todays-plan"
      title={HOME_MODULE_LABELS.todays_plan}
      status={<PlannedPill milestone="Milestone 1" />}
      wide
    >
      <p>
        Up to three priorities, each with a short reason, and the next suggested action. The planner
        arrives in Milestone 1 with local tasks.
      </p>
      {settings.availableHoursInvalid ? (
        <p className="text-caution">
          Your saved available hours could not be read. Set them again so the planner can use them.
        </p>
      ) : summary ? (
        <p>
          It will plan around your available hours: <span className="text-ink">{summary}</span>.
        </p>
      ) : (
        <p>
          No available hours are set, so plans will be an ordered list with effort estimates rather
          than a timed schedule.
        </p>
      )}
      <Link href="/settings/hours" className={linkClass}>
        {summary ? 'Change available hours' : 'Set available hours'}
      </Link>
    </ModuleCard>
  )
}

async function Today() {
  return (
    <ModuleCard
      id="today"
      title={HOME_MODULE_LABELS.today}
      status={<PlannedPill milestone="Milestone 1" />}
      href="/plan"
      hrefLabel="Week"
      wide
    >
      <p>Today&rsquo;s calendar events, tasks and habits.</p>
      <p>
        Local tasks and habits arrive in Milestone 1. Events from connected Google and Outlook
        calendars (read-only, with links back to the original) follow in Milestone 2.
      </p>
    </ModuleCard>
  )
}

async function Briefing({ settings }: HomeModuleProps) {
  return (
    <ModuleCard
      id="briefing"
      title={HOME_MODULE_LABELS.briefing}
      status={<PlannedPill milestone="Milestone 2" />}
    >
      <p>
        The 11:00 briefing and the 22:00 project review will appear here, showing how fresh each
        source was and which connections were unavailable.
      </p>
      <p>
        They will run in <span className="text-ink">{settings.timezone}</span>
        {settings.timezoneConfirmed ? '' : ' (not confirmed yet)'}.
      </p>
    </ModuleCard>
  )
}

async function HealthPreview() {
  return (
    <ModuleCard
      id="health-preview"
      title={HOME_MODULE_LABELS.health_preview}
      status={<PlannedPill milestone="Milestone 3" />}
      href="/health"
      hrefLabel="Open"
    >
      <p>
        WHOOP sleep, recovery and strain with their dates. Scores WHOOP has not finished are shown
        as pending, never as zero.
      </p>
    </ModuleCard>
  )
}

async function MoneyPreview() {
  return (
    <ModuleCard
      id="money-preview"
      title={HOME_MODULE_LABELS.money_preview}
      status={<PlannedPill milestone="Milestone 3" />}
      href="/money"
      hrefLabel="Open"
    >
      <p>
        Balances in their original currency and upcoming renewals. Bank data refreshes about once a
        day, so each balance will show when it was last updated.
      </p>
    </ModuleCard>
  )
}

async function Interests() {
  return (
    <ModuleCard
      id="interests"
      title={HOME_MODULE_LABELS.interests}
      status={<PlannedPill milestone="Milestone 3" />}
      href="/updates"
      hrefLabel="Updates"
    >
      <p>Selected cards from your Updates sections:</p>
      <ul className="flex flex-wrap gap-1.5" aria-label="Updates sections">
        {INTEREST_SECTIONS.map((section) => (
          <li key={section}>
            <Pill>{INTEREST_SECTION_LABELS[section]}</Pill>
          </li>
        ))}
      </ul>
    </ModuleCard>
  )
}

const MODULES: Record<HomeModule, (props: HomeModuleProps) => Promise<React.ReactNode>> = {
  needs_attention: NeedsAttention,
  todays_plan: TodaysPlan,
  today: Today,
  briefing: Briefing,
  health_preview: HealthPreview,
  money_preview: MoneyPreview,
  interests: Interests,
}

export function HomeModuleSection({ module, settings }: { module: HomeModule } & HomeModuleProps) {
  const Component = MODULES[module]
  return <Component settings={settings} />
}
