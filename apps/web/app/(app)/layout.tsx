import { AppShell } from '@/components/shell/app-shell'
import { requireOwner } from '@/lib/server/session'

/**
 * Every route in this group is owner-only. Layouts are not re-run on every
 * client navigation, so pages and server actions must still read data through
 * withOwnerTx()/requireOwner() — never rely on this check alone.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireOwner()
  return <AppShell>{children}</AppShell>
}
