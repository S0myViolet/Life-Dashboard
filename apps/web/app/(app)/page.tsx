import { Suspense } from 'react'
import { HOME_MODULE_LABELS, homeHeading, visibleHomeModules } from '@personal-home/core'
import { getOwnerSettings } from '@personal-home/db'
import { PageHeader } from '@/components/shell/app-shell'
import { HomeModuleSection, isWideHomeModule } from '@/components/home/home-modules'
import { ModuleSkeleton } from '@/components/home/module-card'
import { QuickCapture } from '@/components/home/quick-capture'
import { TimezoneBanner } from '@/components/home/timezone-banner'
import { EmptyState } from '@/components/ui/empty-state'
import { requireOwner, withOwnerTx } from '@/lib/server/session'

export default async function HomePage() {
  await requireOwner()
  const settings = await withOwnerTx((tx) => getOwnerSettings(tx))

  if (!settings) {
    // The settings row is created by the foundation migration; if it is missing,
    // say so instead of rendering a Home built on guesses.
    return (
      <>
        <PageHeader title="Home" />
        <EmptyState title="Settings could not be loaded">
          The owner settings record is missing, so Home cannot pick your timezone or layout. Run the
          database migrations and reload.
        </EmptyState>
      </>
    )
  }

  const heading = homeHeading(new Date(), settings.timezone)
  const name = settings.displayName?.trim()
  const modules = visibleHomeModules(settings.homeLayout)

  return (
    <>
      <PageHeader
        title={name ? `${heading.greeting}, ${name}` : heading.greeting}
        subtitle={
          <>
            <time dateTime={heading.localDate} data-testid="home-date">
              {heading.dateLabel}
            </time>
            <span className="text-ink-faint"> · {heading.timezone}</span>
          </>
        }
      />
      {settings.timezoneConfirmed ? null : <TimezoneBanner savedTimezone={settings.timezone} />}
      <div className="grid gap-4 lg:grid-cols-2">
        {modules.map((module) => (
          <Suspense
            key={module}
            fallback={
              <ModuleSkeleton title={HOME_MODULE_LABELS[module]} wide={isWideHomeModule(module)} />
            }
          >
            <HomeModuleSection module={module} settings={settings} />
          </Suspense>
        ))}
      </div>
      <QuickCapture />
    </>
  )
}
