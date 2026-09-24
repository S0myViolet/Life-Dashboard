'use client'

import Link from 'next/link'
import { useActionState } from 'react'
import { attachConversationAction, type AttachState } from '@/lib/capture/actions'
import { SubmitButton } from '@/components/capture/confirm-submit-button'
import { errorClass, helpClass, inputClass, labelClass } from '@/components/capture/form-styles'

const initial: AttachState = { status: 'idle' }

/** Same literal as ATTACH_KEEP_PROJECT in lib/capture/forms.ts (not imported, to keep zod out of the client bundle). */
const KEEP_PROJECT = 'keep'

export interface ProjectOption {
  id: string
  name: string
}

/**
 * Select a ChatGPT or Claude conversation for collection and attach it to a
 * project. With `fixedUrl` (the /projects/attach page opened by the helper) the
 * link is shown read-only and only the project is chosen.
 */
export function AttachConversationForm({
  projects,
  fixedUrl,
  defaultProjectId,
  submitLabel = 'Start collecting',
}: {
  projects: ProjectOption[]
  fixedUrl?: string
  defaultProjectId?: string | null
  submitLabel?: string
}) {
  const [state, action] = useActionState(attachConversationAction, initial)
  const urlError = state.status === 'error' && state.field !== 'projectId' ? state.message : null
  const projectError = state.status === 'error' && state.field === 'projectId' ? state.message : null

  return (
    <form action={action} className="space-y-3" noValidate>
      {fixedUrl ? (
        <input type="hidden" name="url" value={fixedUrl} />
      ) : (
        <div>
          <label htmlFor="attach-url" className={labelClass}>
            Conversation link
          </label>
          <input
            id="attach-url"
            name="url"
            type="url"
            inputMode="url"
            required
            maxLength={2048}
            autoComplete="off"
            spellCheck={false}
            placeholder="https://chatgpt.com/c/… or https://claude.ai/chat/…"
            className={inputClass}
            aria-invalid={urlError ? true : undefined}
            aria-describedby="attach-url-help"
          />
          <p id="attach-url-help" className={urlError ? errorClass : helpClass}>
            {urlError ?? 'Copy it from the address bar while the conversation is open.'}
          </p>
        </div>
      )}

      <div>
        <label htmlFor="attach-project" className={labelClass}>
          Project
        </label>
        <select
          id="attach-project"
          name="projectId"
          defaultValue={defaultProjectId ?? (fixedUrl ? '' : KEEP_PROJECT)}
          className={inputClass}
          aria-invalid={projectError ? true : undefined}
          aria-describedby={projectError ? 'attach-project-error' : undefined}
        >
          {fixedUrl ? null : (
            // The pasted link may already be selected: by default its project is left alone.
            <option value={KEEP_PROJECT}>Keep its current project (none if new)</option>
          )}
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {projectError ? (
          <p id="attach-project-error" className={errorClass}>
            {projectError}
          </p>
        ) : null}
      </div>

      {fixedUrl && urlError ? (
        <p className={errorClass} role="alert">
          {urlError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="primary" pendingLabel="Saving…">
          {submitLabel}
        </SubmitButton>
      </div>

      <div role="status" aria-live="polite">
        {state.status === 'selected' ? (
          <div className="rounded-xl border border-positive/20 bg-positive-soft px-3 py-2 text-sm text-ink">
            <p className="font-medium text-positive">
              {state.created ? 'Selected.' : state.projectKept ? 'Updated; its project is unchanged.' : 'Updated.'}{' '}
              The helper collects this {state.provider} conversation whenever it is open in Chrome.
            </p>
            <p className="mt-1 text-ink-muted">
              The helper refreshes its list within a few minutes, or when you return to the
              conversation&apos;s tab.{' '}
              <Link href="/settings/chrome-helper" className="text-accent hover:text-accent-strong">
                See capture status
              </Link>
            </p>
          </div>
        ) : null}
      </div>
    </form>
  )
}
