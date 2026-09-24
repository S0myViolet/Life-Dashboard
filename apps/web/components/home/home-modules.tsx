/**
 * Home modules. Each is an async server component rendered inside its own <Suspense>
 * boundary (app/(app)/page.tsx), so a slow or failing source never blocks the rest of Home.
 * Modules read saved data only: no provider or AI call happens while Home renders.
 *
 * Health, money and interests arrive with Milestone 3 and say so; nothing shows fabricated
 * zeros or "all clear".
 */
import {
  HOME_MODULE_LABELS,
  INTEREST_SECTIONS,
  INTEREST_SECTION_LABELS,
  type HomeModule,
} from '@personal-home/core'
import type { OwnerSettings } from '@personal-home/db'
import { Pill } from '@/components/ui/status-pill'
import { BriefingModule } from './briefing'
import { ModuleCard, PlannedPill } from './module-card'
import { NeedsAttentionModule } from './needs-attention'
import { PlanModule } from './plan-module'
import { TodayModule } from './today'

export interface HomeModuleProps {
  settings: OwnerSettings
}

const WIDE_MODULES: ReadonlySet<HomeModule> = new Set(['needs_attention', 'todays_plan', 'today'])

export function isWideHomeModule(module: HomeModule): boolean {
  return WIDE_MODULES.has(module)
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

const MODULES: Record<HomeModule, (props: HomeModuleProps) => React.ReactNode> = {
  needs_attention: NeedsAttentionModule,
  todays_plan: PlanModule,
  today: TodayModule,
  briefing: BriefingModule,
  health_preview: HealthPreview,
  money_preview: MoneyPreview,
  interests: Interests,
}

export function HomeModuleSection({ module, settings }: { module: HomeModule } & HomeModuleProps) {
  const Component = MODULES[module]
  return <Component settings={settings} />
}
