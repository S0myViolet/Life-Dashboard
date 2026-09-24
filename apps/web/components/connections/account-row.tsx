import { ChevronDown } from 'lucide-react'
import { ConnectionStatusPill } from '@/components/ui/status-pill'
import { buttonClass } from '@/components/ui/button'
import {
  checkConnectionNow,
  disconnectConnection,
  pauseConnection,
  renameConnection,
  resumeConnection,
} from '@/app/(app)/settings/connections/actions'
import type { AccountView } from '@/lib/integrations/view'
import { SubmitButton } from './submit-button'
import { Timestamp } from './timestamp'

const summaryClass = `${buttonClass('ghost')} cursor-pointer list-none [&::-webkit-details-marker]:hidden`

/** One connected account: health, sanitised error, and the owner's controls. */
export function AccountRow({
  account,
  providerName,
  supportsRevoke,
  now,
  timeZone,
}: {
  account: AccountView
  providerName: string
  supportsRevoke: boolean
  now: Date
  timeZone: string
}) {
  const headingId = `account-${account.id}`
  return (
    <li
      aria-labelledby={headingId}
      className="rounded-xl border border-line bg-surface-muted/40 px-3 py-3 sm:px-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={headingId} className="min-w-0 break-all text-sm font-semibold text-ink">
          {account.label}
        </h4>
        <ConnectionStatusPill status={account.status} />
      </div>

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-ink-faint">Last attempt</dt>
        <dd className="text-ink-muted">
          <Timestamp date={account.lastAttemptAt} now={now} timeZone={timeZone} />
        </dd>
        <dt className="text-ink-faint">Last success</dt>
        <dd className="text-ink-muted">
          <Timestamp date={account.lastSuccessAt} now={now} timeZone={timeZone} />
        </dd>
        {account.nextAttemptAt ? (
          <>
            <dt className="text-ink-faint">Next attempt</dt>
            <dd className="text-ink-muted">
              <Timestamp date={account.nextAttemptAt} now={now} timeZone={timeZone} />
            </dd>
          </>
        ) : null}
        {account.errorMessage ? (
          <>
            <dt className="text-ink-faint">Problem</dt>
            <dd className="break-words text-danger">{account.errorMessage}</dd>
          </>
        ) : null}
      </dl>

      {account.paused ? (
        <p className="mt-2 text-sm text-caution">
          Paused: background checks are stopped and stored access is kept until you resume.
        </p>
      ) : null}
      {account.status === 'needs_reconnect' && !account.errorMessage ? (
        <p className="mt-2 text-sm text-ink-muted">
          {providerName} no longer accepts the stored access. Reconnect to resume background checks.
        </p>
      ) : null}
      {account.missingAccess.length > 0 ? (
        <p className="mt-2 text-sm text-caution">
          Not granted: {account.missingAccess.join(', ')}.{' '}
          {account.noDataAccess
            ? 'Neither mail nor calendar can be read from this account.'
            : 'Those features stay off for this account.'}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-start gap-2">
        {account.reconnectHref ? (
          // Plain link: starting OAuth creates a one-time state, so it must never be prefetched.
          <a href={account.reconnectHref} className={buttonClass('primary')}>
            Reconnect
          </a>
        ) : null}

        {account.offerCheckNow ? (
          <form action={checkConnectionNow}>
            <input type="hidden" name="id" value={account.id} />
            <SubmitButton pendingLabel="Checking…">Check now</SubmitButton>
          </form>
        ) : null}

        <form action={account.paused ? resumeConnection : pauseConnection}>
          <input type="hidden" name="id" value={account.id} />
          <SubmitButton pendingLabel={account.paused ? 'Resuming…' : 'Pausing…'}>
            {account.paused ? 'Resume' : 'Pause'}
          </SubmitButton>
        </form>

        <details className="group">
          <summary className={summaryClass}>
            Rename
            <ChevronDown
              aria-hidden
              className="size-4 transition-transform group-open:rotate-180"
            />
          </summary>
          <form action={renameConnection} className="mt-2 flex flex-wrap items-end gap-2">
            <input type="hidden" name="id" value={account.id} />
            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              Account label
              <input
                name="label"
                defaultValue={account.label}
                required
                maxLength={200}
                autoComplete="off"
                className="min-h-11 rounded-lg border border-line-strong bg-surface px-3 text-ink sm:min-h-10"
              />
            </label>
            <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
          </form>
        </details>

        <details className="group">
          <summary className={`${summaryClass} text-danger hover:text-danger`}>
            Disconnect…
            <ChevronDown
              aria-hidden
              className="size-4 transition-transform group-open:rotate-180"
            />
          </summary>
          <div
            role="group"
            aria-label={`Confirm disconnecting ${account.label}`}
            className="mt-2 max-w-prose rounded-lg border border-danger/30 bg-danger-soft/50 p-3 text-sm text-ink"
          >
            <p>
              Disconnect <strong className="break-all">{account.label}</strong>? Stored access and
              sync progress are deleted and background checks stop.{' '}
              {supportsRevoke
                ? `Access is also revoked at ${providerName}.`
                : `${providerName} offers no way for apps to revoke access, so you will be shown where to remove it yourself.`}
            </p>
            <form action={disconnectConnection} className="mt-3">
              <input type="hidden" name="id" value={account.id} />
              <input type="hidden" name="confirm" value="yes" />
              <SubmitButton variant="danger" pendingLabel="Disconnecting…">
                Yes, disconnect
              </SubmitButton>
            </form>
          </div>
        </details>
      </div>
    </li>
  )
}
