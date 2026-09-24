import {
  Bell,
  Puzzle,
  Clock,
  Database,
  Globe,
  LayoutDashboard,
  Link2,
  PiggyBank,
  Smartphone,
} from 'lucide-react'
import { HOME_MODULES, summarizeAvailableHours, visibleHomeModules } from '@personal-home/core'
import { getOwnerSettings } from '@personal-home/db'
import { PageHeader } from '@/components/shell/app-shell'
import { SettingsGroup, SettingsRow } from '@/components/settings/settings-list'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { withOwnerTx } from '@/lib/server/session'

export const metadata = { title: 'Settings' }

export default async function SettingsPage() {
  const { settings, email } = await withOwnerTx(async (tx, session) => ({
    settings: await getOwnerSettings(tx),
    email: session.email,
  }))

  const timezoneValue = settings
    ? `${settings.timezone} · ${settings.timezoneConfirmed ? 'Confirmed' : 'Not confirmed yet'}`
    : 'Could not be loaded'
  const hoursValue = !settings
    ? 'Could not be loaded'
    : settings.availableHoursInvalid
      ? 'Saved hours need fixing'
      : (summarizeAvailableHours(settings.availableHours) ?? 'Not set (optional)')
  const layoutValue = settings
    ? `${visibleHomeModules(settings.homeLayout).length} of ${HOME_MODULES.length} modules shown`
    : 'Could not be loaded'

  return (
    <>
      <PageHeader title="Settings" />
      <SettingsGroup title="General">
        <SettingsRow href="/settings/timezone" label="Timezone" value={timezoneValue} icon={Globe} />
        <SettingsRow href="/settings/hours" label="Available hours" value={hoursValue} icon={Clock} />
        <SettingsRow
          href="/settings/home-layout"
          label="Home layout"
          value={layoutValue}
          icon={LayoutDashboard}
        />
      </SettingsGroup>

      <SettingsGroup title="Connections">
        <SettingsRow
          href="/settings/connections"
          label="Connected accounts"
          value="Email, calendar, banking, health and interests"
          icon={Link2}
        />
        <SettingsRow
          href="/settings/chrome-helper"
          label="Chrome helper"
          value="ChatGPT and Claude project capture"
          icon={Puzzle}
        />
      </SettingsGroup>

      <SettingsGroup title="App">
        <SettingsRow
          href="/settings/install"
          label="Install on iPhone"
          value="Add to Home Screen"
          icon={Smartphone}
        />
        <SettingsRow
          href="/settings/notifications"
          label="Notifications"
          value="Planned · Milestone 2"
          icon={Bell}
        />
      </SettingsGroup>

      <SettingsGroup title="Data and costs">
        <SettingsRow
          href="/settings/data"
          label="Data retention, export and deletion"
          value="Retention defaults"
          icon={Database}
        />
        <SettingsRow
          href="/settings/budget"
          label="Budget and running costs"
          value="Planned · Milestone 2"
          icon={PiggyBank}
        />
      </SettingsGroup>

      <Card as="section" aria-labelledby="account-title">
        <h2 id="account-title" className="text-[15px] font-semibold tracking-tight text-ink">
          Account
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          {email ? (
            <>
              Signed in as <span className="text-ink">{email}</span>, the owner of this dashboard.
            </>
          ) : (
            'Signed in as the owner of this dashboard.'
          )}
        </p>
        <form action="/auth/signout" method="post" className="mt-3">
          <Button type="submit" variant="secondary">
            Sign out
          </Button>
        </form>
        <p className="mt-2 text-xs text-ink-faint">
          Signing out clears cached pages and local drafts on this device.
        </p>
      </Card>
    </>
  )
}
