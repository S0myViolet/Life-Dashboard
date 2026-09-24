import { InstallGuide } from '@/components/settings/install-guide'
import { SettingsSubpageHeader } from '@/components/settings/settings-list'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Install on iPhone' }

export default async function InstallPage() {
  await requireOwner()
  return (
    <>
      <SettingsSubpageHeader
        title="Install on iPhone"
        subtitle="Personal Home is a web app. Adding it to your Home Screen gives it its own icon and full-screen window."
      />
      <InstallGuide />
    </>
  )
}
