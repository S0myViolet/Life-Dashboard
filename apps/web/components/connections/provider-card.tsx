import Link from 'next/link'
import { Card } from '@/components/ui/card'
import { buttonClass } from '@/components/ui/button'
import { ConnectionStatusPill, Pill } from '@/components/ui/status-pill'
import type { ProviderView } from '@/lib/integrations/view'
import { AccountRow } from './account-row'

function SettingNames({ names }: { names: string[] }) {
  return (
    <ul className="mt-1 flex flex-wrap gap-1.5">
      {names.map((name) => (
        <li key={name}>
          <code className="rounded-md border border-line bg-surface-muted px-1.5 py-0.5 font-mono text-xs text-ink">
            {name}
          </code>
        </li>
      ))}
    </ul>
  )
}

function ProviderPill({ view }: { view: ProviderView }) {
  const a = view.availability
  switch (a.kind) {
    case 'needs_setup':
      return <ConnectionStatusPill status="needs_setup" />
    case 'later':
      return <Pill>Milestone {a.milestone}</Pill>
    case 'extension':
      return <Pill>Chrome helper</Pill>
    case 'api_key_configured':
      return <ConnectionStatusPill status="not_connected" />
    case 'connectable':
      return view.accounts.length === 0 ? <ConnectionStatusPill status="not_connected" /> : null
  }
}

/** One provider: what it provides, whether it can be connected now, and its accounts. */
export function ProviderCard({
  view,
  now,
  timeZone,
}: {
  view: ProviderView
  now: Date
  timeZone: string
}) {
  const { info, availability: a } = view
  const headingId = `provider-${info.provider}`
  return (
    <Card as="article" aria-labelledby={headingId} id={info.provider}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={headingId} className="text-[15px] font-semibold tracking-tight text-ink">
            {info.displayName}
          </h3>
          <p className="mt-0.5 text-sm text-ink-muted">{info.provides}</p>
        </div>
        <ProviderPill view={view} />
      </div>

      {a.kind === 'needs_setup' ? (
        <div className="mt-3 text-sm text-ink-muted">
          <p>
            These server settings are missing (names only; values stay in your server
            configuration):
          </p>
          <SettingNames names={a.missing} />
          <p className="mt-2">
            <Link href={view.setupHref} className="text-accent underline-offset-2 hover:underline">
              How to set up {info.displayName}
            </Link>
          </p>
        </div>
      ) : null}

      {a.kind === 'later' ? (
        <div className="mt-3 text-sm text-ink-muted">
          <p>Arrives in Milestone {a.milestone}. Nothing is collected from it yet.</p>
          {a.missing.length > 0 ? (
            <>
              <p className="mt-2">It will need these server settings:</p>
              <SettingNames names={a.missing} />
            </>
          ) : null}
        </div>
      ) : null}

      {a.kind === 'extension' ? (
        <p className="mt-3 text-sm text-ink-muted">
          Collected by the Chrome helper from conversations you select.{' '}
          <Link
            href="/settings/chrome-helper"
            className="text-accent underline-offset-2 hover:underline"
          >
            Set up the Chrome helper
          </Link>
        </p>
      ) : null}

      {a.kind === 'api_key_configured' ? (
        <p className="mt-3 text-sm text-ink-muted">
          The API key is set on the server. Nothing is imported yet: banking arrives in Milestone{' '}
          {info.syncMilestone}, after your account types are validated with the verification script.{' '}
          <Link href={view.setupHref} className="text-accent underline-offset-2 hover:underline">
            Setup and verification
          </Link>
        </p>
      ) : null}

      {view.accounts.length > 0 ? (
        <ul className="mt-3 space-y-2" aria-label={`${info.displayName} accounts`}>
          {view.accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              providerName={info.displayName}
              supportsRevoke={view.supportsRevoke}
              now={now}
              timeZone={timeZone}
            />
          ))}
        </ul>
      ) : a.kind === 'connectable' ? (
        <p className="mt-3 text-sm text-ink-muted">
          No accounts connected. Mail and calendar import arrives in Milestone {info.syncMilestone};
          connecting now proves background access.
        </p>
      ) : null}

      {view.connectHref ? (
        <div className="mt-3">
          {/* Plain link: starting OAuth creates a one-time state, so it must never be prefetched. */}
          <a
            href={view.connectHref}
            className={buttonClass(view.accounts.length ? 'secondary' : 'primary')}
          >
            {view.accounts.length
              ? 'Connect another account'
              : `Connect a ${info.displayName.replace(/ \(.*\)$/, '')} account`}
          </a>
        </div>
      ) : null}
    </Card>
  )
}
