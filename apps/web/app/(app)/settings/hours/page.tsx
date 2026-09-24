import { getOwnerSettings } from '@personal-home/db'
import { AvailableHoursEditor } from '@/components/settings/available-hours-editor'
import { SettingsSubpageHeader } from '@/components/settings/settings-list'
import { EmptyState } from '@/components/ui/empty-state'
import { withOwnerTx } from '@/lib/server/session'

export const metadata = { title: 'Available hours' }

export default async function AvailableHoursPage() {
  const settings = await withOwnerTx((tx) => getOwnerSettings(tx))
  return (
    <>
      <SettingsSubpageHeader
        title="Available hours"
        subtitle={
          settings ? (
            <>
              Optional. The daily plan fits suggestions into these times ({settings.timezone}) and
              leaves about a fifth of them free. Without them it suggests an ordered list and effort
              estimates instead of a schedule.
            </>
          ) : undefined
        }
      />
      {!settings ? (
        <EmptyState title="Settings could not be loaded" />
      ) : (
        <>
          {settings.availableHoursInvalid ? (
            <p role="alert" className="mb-4 rounded-xl bg-caution-soft px-3 py-2 text-sm text-caution">
              The saved hours could not be read, so none are shown. Set them again and save.
            </p>
          ) : null}
          <AvailableHoursEditor initial={settings.availableHours} />
        </>
      )}
    </>
  )
}
