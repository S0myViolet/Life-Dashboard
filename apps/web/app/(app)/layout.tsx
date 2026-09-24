import { PendingDrafts } from '@/components/notes/pending-drafts'
import { AppShell } from '@/components/shell/app-shell'
import { RegisterServiceWorker } from '@/lib/pwa/register-service-worker'
import { requireOwner } from '@/lib/server/session'

/**
 * Every route in this group is owner-only. Layouts are not re-run on every
 * client navigation, so pages and server actions must still read data through
 * withOwnerTx()/requireOwner() — never rely on this check alone.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireOwner()
  return (
    <AppShell>
      <RegisterServiceWorker />
      {/* Syncs drafts saved on this device (e.g. written offline) from any page. */}
      <PendingDrafts />
      {children}
    </AppShell>
  )
}
