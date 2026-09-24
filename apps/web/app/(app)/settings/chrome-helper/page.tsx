import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { CAPTURE_LIMITS } from '@personal-home/core'
import { PageHeader } from '@/components/shell/app-shell'
import { Card, CardHeader } from '@/components/ui/card'
import { CaptureConversationList } from '@/components/capture/conversation-list'
import { DeviceList } from '@/components/capture/device-list'
import { PairingPanel } from '@/components/capture/pairing-panel'
import { captureConfiguredDashboardOrigin } from '@/lib/capture/config'
import { loadChromeHelperPage } from '@/lib/capture/data'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Chrome helper' }

export default async function ChromeHelperPage() {
  const session = await requireOwner()
  const data = await loadChromeHelperPage(session)
  const now = new Date()

  return (
    <>
      <Link
        href="/settings"
        className="mb-2 inline-flex min-h-11 items-center gap-1 text-sm text-ink-muted hover:text-ink sm:min-h-0"
      >
        <ChevronLeft aria-hidden className="size-4" />
        Settings
      </Link>
      <PageHeader
        title="Chrome helper"
        subtitle="Collects the ChatGPT and Claude conversations you select, from your own signed-in Chrome."
      />

      <div className="space-y-4">
        <Card aria-labelledby="pair-heading">
          <CardHeader title="Pair a browser" id="pair-heading" />
          <PairingPanel
            dashboardOrigin={captureConfiguredDashboardOrigin()}
            liveCodeExpiresAt={data.liveCodeExpiresAt?.toISOString() ?? null}
            timeZone={data.timezone}
          />
        </Card>

        <Card aria-labelledby="devices-heading">
          <CardHeader title="Paired browsers" id="devices-heading" />
          <DeviceList devices={data.devices} now={now} timeZone={data.timezone} />
        </Card>

        <Card aria-labelledby="conversations-heading">
          <CardHeader
            title="Selected conversations"
            id="conversations-heading"
            href="/projects"
            hrefLabel="Attach more"
          />
          <CaptureConversationList
            conversations={data.conversations}
            now={now}
            timeZone={data.timezone}
          />
        </Card>

        <Card aria-labelledby="collected-heading">
          <CardHeader title="What the helper collects" id="collected-heading" />
          <div className="space-y-2 text-sm text-ink-muted">
            <p>
              Only conversations you select, and only the user and assistant text Chrome actually
              rendered while the conversation was open. Long chats are drawn a window at a time, so
              older messages are collected when you scroll through them once. Attachments, images,
              hidden branches and anything never shown on screen are not collected.
            </p>
            <p>
              A page that shows only part of a conversation never removes saved messages, and an
              edited or regenerated message is kept as a new version. If a page is signed out, shows
              a verification check or looks different than expected, collection of that conversation
              pauses and the last good data is kept until you choose Reconnect.
            </p>
            <p>
              Raw conversation text is kept for {CAPTURE_LIMITS.rawTextRetentionDays} days; after
              that only fingerprints, times and summaries remain. Removing a conversation deletes
              everything collected from it.
            </p>
            <p>
              Background revisits (the helper reopening selected conversations every 30 minutes) are
              an opt-in prototype that is off by default. ChatGPT&apos;s and Claude&apos;s terms
              restrict automated access, so the helper explains the risk before you switch it on.
            </p>
          </div>
        </Card>
      </div>
    </>
  )
}
