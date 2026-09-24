import Link from 'next/link'
import { SettingsSubpageHeader } from '@/components/settings/settings-list'
import { PlannedSection } from '@/components/ui/planned-section'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'Notifications' }

export default async function NotificationsPage() {
  await requireOwner()
  return (
    <>
      <SettingsSubpageHeader title="Notifications" />
      <PlannedSection milestone="Milestone 2">
        <p className="text-ink">Nothing is sent yet, and this page never asks for permission.</p>
        <p>When notifications arrive, the defaults will be:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>The 11:00 briefing and the 22:00 project review.</li>
          <li>
            Reminders you create, and verified explicit deadlines due within 24 hours. Uncertain AI
            guesses never trigger an urgent alert.
          </li>
          <li>Interest alerts (news, football, music) stay off until you turn them on per section.</li>
          <li>Repeats are grouped; backfilled mail, old albums and resynced matches do not alert.</li>
          <li>
            Lock-screen text is generic. Email, money and journal details appear only after you open
            the app.
          </li>
        </ul>
        <p>
          Delivery uses standard Web Push plus an in-app inbox. Permission is requested only when
          you tap Enable notifications, and saying no does not block anything. On iPhone this needs
          the <Link href="/settings/install" className="text-accent hover:text-accent-strong">Home
          Screen app</Link>.
        </p>
      </PlannedSection>
    </>
  )
}
