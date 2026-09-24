import { ExternalLink } from 'lucide-react'
import { CAPTURE_PROVIDER_LABELS } from '@personal-home/core'
import type { CaptureConversationRow } from '@personal-home/db'
import { EmptyState } from '@/components/ui/empty-state'
import { Pill } from '@/components/ui/status-pill'
import { removeConversationAction, setConversationPausedAction } from '@/lib/capture/actions'
import {
  CAPTURE_STATE_COPY,
  captureConversationLabel,
  captureCoverageSummary,
  captureRelativeTime,
  captureResumeLabel,
} from '@/lib/capture/view'
import { SubmitButton } from './confirm-submit-button'

export function CaptureStatePill({ state }: { state: CaptureConversationRow['captureState'] }) {
  const copy = CAPTURE_STATE_COPY[state]
  return <Pill tone={copy.tone}>{copy.label}</Pill>
}

/**
 * Selected conversations with their capture state, last capture and an honest
 * coverage sentence. `compact` hides the coverage detail and actions (Projects page).
 */
export function CaptureConversationList({
  conversations,
  now,
  timeZone,
  compact = false,
  showProject = true,
  emptyTitle = 'No conversations selected yet',
  emptyBody,
}: {
  conversations: CaptureConversationRow[]
  now: Date
  timeZone: string
  compact?: boolean
  showProject?: boolean
  emptyTitle?: string
  emptyBody?: React.ReactNode
}) {
  if (conversations.length === 0) {
    return (
      <EmptyState title={emptyTitle}>
        {emptyBody ??
          'Attach a ChatGPT or Claude conversation on the Projects page, or use “Track this conversation” in the helper’s popup.'}
      </EmptyState>
    )
  }
  return (
    <ul className="divide-y divide-line">
      {conversations.map((c) => {
        const label = captureConversationLabel(c)
        const copy = CAPTURE_STATE_COPY[c.captureState]
        return (
          <li key={c.id} className="py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-w-0 items-center gap-1 text-sm font-medium text-ink hover:text-accent-strong"
                  >
                    <span className="truncate">{label}</span>
                    <ExternalLink aria-hidden className="size-3.5 shrink-0 text-ink-faint" />
                    <span className="sr-only">(opens {CAPTURE_PROVIDER_LABELS[c.provider]})</span>
                  </a>
                  <Pill>{CAPTURE_PROVIDER_LABELS[c.provider]}</Pill>
                  <CaptureStatePill state={c.captureState} />
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {showProject ? (
                    <>
                      {c.projectName ? `Project: ${c.projectName}` : 'No project'}
                      {' · '}
                    </>
                  ) : null}
                  {c.lastCapturedAt
                    ? `Last captured ${captureRelativeTime(c.lastCapturedAt, now, timeZone)}`
                    : 'Not captured yet'}
                </p>
              </div>
            </div>

            {compact ? null : (
              <>
                <p className="mt-2 text-sm text-ink-muted">{captureCoverageSummary(c)}</p>
                {c.captureState !== 'active' ? (
                  <p
                    className={`mt-1 text-sm ${copy.tone === 'danger' ? 'text-danger' : 'text-ink-muted'}`}
                  >
                    {copy.help}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  <form action={setConversationPausedAction}>
                    <input type="hidden" name="conversationId" value={c.id} />
                    {c.captureState === 'active' ? (
                      <>
                        <input type="hidden" name="paused" value="true" />
                        <SubmitButton pendingLabel="Pausing…" ariaLabel={`Pause ${label}`}>
                          Pause
                        </SubmitButton>
                      </>
                    ) : (
                      <>
                        <input type="hidden" name="paused" value="false" />
                        <SubmitButton
                          variant="primary"
                          pendingLabel="Resuming…"
                          ariaLabel={`${captureResumeLabel(c.captureState)} ${label}`}
                        >
                          {captureResumeLabel(c.captureState)}
                        </SubmitButton>
                      </>
                    )}
                  </form>
                  <form action={removeConversationAction}>
                    <input type="hidden" name="conversationId" value={c.id} />
                    <SubmitButton
                      variant="ghost"
                      confirm={`Remove “${label}”? Collection stops and its ${c.messageCount} saved message(s) are deleted from Personal Home. Nothing changes in ${CAPTURE_PROVIDER_LABELS[c.provider]}.`}
                      pendingLabel="Removing…"
                      ariaLabel={`Remove ${label}`}
                    >
                      Remove
                    </SubmitButton>
                  </form>
                </div>
              </>
            )}
          </li>
        )
      })}
    </ul>
  )
}
