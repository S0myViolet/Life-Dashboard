import { getOwnerSettings } from '@personal-home/db'
import { HomeLayoutEditor } from '@/components/settings/home-layout-editor'
import { SettingsSubpageHeader } from '@/components/settings/settings-list'
import { EmptyState } from '@/components/ui/empty-state'
import { withOwnerTx } from '@/lib/server/session'

export const metadata = { title: 'Home layout' }

export default async function HomeLayoutPage() {
  const settings = await withOwnerTx((tx) => getOwnerSettings(tx))
  return (
    <>
      <SettingsSubpageHeader
        title="Home layout"
        subtitle="Choose the order of Home's other sections and hide the ones you do not need. Needs attention and your plan for today always stay at the top."
      />
      {settings ? (
        <HomeLayoutEditor layout={settings.homeLayout} />
      ) : (
        <EmptyState title="Settings could not be loaded" />
      )}
    </>
  )
}
