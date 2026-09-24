import Link from 'next/link'
import { CONNECTION_PROVIDER_INFO } from '@personal-home/core'
import { connectionEventsRecent, connectionsList, type ConnectionEventRow } from '@personal-home/db'
import { PageHeader } from '@/components/shell/app-shell'
import { Card } from '@/components/ui/card'
import { FlashBanner } from '@/components/connections/flash-banner'
import { ProviderCard } from '@/components/connections/provider-card'
import { Timestamp } from '@/components/connections/timestamp'
import { connectionsFlash } from '@/lib/integrations/flash'
import { providerSetup } from '@/lib/integrations/settings'
import { buildConnectionsView } from '@/lib/integrations/view'
import { requireOwner, withOwnerTx } from '@/lib/server/session'

export const metadata = { title: 'Connections' }

type SearchParams = Record<string, string | string[] | undefined>

const REVOKE_TEXT: Record<NonNullable<ConnectionEventRow['revokeOutcome']>, string> = {
  revoked: 'access revoked at the provider',
  already_invalid: 'access had already ended at the provider',
  not_supported: 'the provider cannot revoke access for apps; remove it in your account settings',
  failed: 'revoking at the provider failed; remove access in your account settings',
}

function eventText(e: ConnectionEventRow): string {
  const name = CONNECTION_PROVIDER_INFO[e.provider].displayName
  switch (e.kind) {
    case 'connected':
      return `Connected ${name}`
    case 'reconnected':
      return `Reconnected ${name}`
    case 'paused':
      return `Paused ${name}`
    case 'resumed':
      return `Resumed ${name}`
    case 'renamed':
      return `Renamed ${name} account`
    case 'disconnected':
      return `Disconnected ${name}: ${e.revokeOutcome ? REVOKE_TEXT[e.revokeOutcome] : 'tokens deleted'}`
  }
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  await requireOwner()
  const sp = await searchParams
  const { rows, events, timeZone } = await withOwnerTx(async (tx) => {
    const [rows, events, settings] = await Promise.all([
      connectionsList(tx),
      connectionEventsRecent(tx, 8),
      tx<{ timezone: string }[]>`select timezone from public.owner_settings where singleton`,
    ])
    return { rows, events, timeZone: settings[0]?.timezone ?? 'UTC' }
  })

  const groups = buildConnectionsView({ rows, setup: providerSetup })
  const flash = connectionsFlash(sp)
  const now = new Date()

  return (
    <>
      <PageHeader
        title="Connections"
        subtitle="Connect each account separately. Everything else keeps working with nothing connected."
        actions={
          <Link
            href="/settings/connections/setup"
            className="inline-flex min-h-11 items-center rounded-xl px-3 text-sm text-accent hover:bg-surface-muted sm:min-h-10"
          >
            Setup guide
          </Link>
        }
      />

      {flash ? <FlashBanner flash={flash} /> : null}

      <div className="space-y-8">
        {groups.map((group) => (
          <section key={group.group} aria-labelledby={`group-${group.group}`}>
            <h2
              id={`group-${group.group}`}
              className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-faint"
            >
              {group.label}
            </h2>
            <div className="space-y-3">
              {group.providers.map((view) => (
                <ProviderCard key={view.info.provider} view={view} now={now} timeZone={timeZone} />
              ))}
            </div>
          </section>
        ))}

        {events.length > 0 ? (
          <section aria-labelledby="connection-history">
            <h2
              id="connection-history"
              className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-faint"
            >
              Recent changes
            </h2>
            <Card>
              <ul className="space-y-2 text-sm">
                {events.map((e) => (
                  <li key={e.id} className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
                    <span className="min-w-0 break-words text-ink">
                      {eventText(e)} <span className="text-ink-muted">({e.accountLabel})</span>
                    </span>
                    <span className="text-ink-faint">
                      <Timestamp date={e.createdAt} now={now} timeZone={timeZone} />
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        ) : null}
      </div>
    </>
  )
}
