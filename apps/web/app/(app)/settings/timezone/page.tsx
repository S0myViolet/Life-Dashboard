import { homeHeading } from '@personal-home/core'
import { getOwnerSettings } from '@personal-home/db'
import { SettingsSubpageHeader } from '@/components/settings/settings-list'
import { TimezoneForm } from '@/components/settings/timezone-form'
import { Card } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Pill } from '@/components/ui/status-pill'
import { withOwnerTx } from '@/lib/server/session'
import { timezonePickerGroups } from '@/lib/settings/timezones'

export const metadata = { title: 'Timezone' }

export default async function TimezoneSettingsPage() {
  const { settings, groups } = await withOwnerTx(async (tx) => ({
    settings: await getOwnerSettings(tx),
    groups: await timezonePickerGroups(tx),
  }))

  if (!settings) {
    return (
      <>
        <SettingsSubpageHeader title="Timezone" />
        <EmptyState title="Settings could not be loaded" />
      </>
    )
  }

  const now = new Date()
  const heading = homeHeading(now, settings.timezone)
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: heading.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now)

  return (
    <>
      <SettingsSubpageHeader
        title="Timezone"
        subtitle="Used for Home, the daily plan, reminders and the 11:00 and 22:00 briefings."
      />
      <Card aria-labelledby="tz-current-title" className="mb-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="tz-current-title" className="text-[15px] font-semibold text-ink">
            {settings.timezone}
          </h2>
          {settings.timezoneConfirmed ? (
            <Pill tone="positive">Confirmed</Pill>
          ) : (
            <Pill tone="caution">Not confirmed yet</Pill>
          )}
        </div>
        <p className="mt-1 text-sm text-ink-muted">
          It is {time} on {heading.dateLabel} there.
          {settings.timezoneConfirmed
            ? ''
            : ' This is the default until you confirm or choose a timezone.'}
        </p>
      </Card>
      <Card aria-label="Change timezone">
        <TimezoneForm
          current={settings.timezone}
          confirmed={settings.timezoneConfirmed}
          groups={groups}
        />
      </Card>
    </>
  )
}
