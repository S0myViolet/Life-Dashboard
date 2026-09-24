'use client'

import { useActionState, useEffect, useRef } from 'react'
import { PROJECT_KINDS, PROJECT_KIND_LABELS } from '@personal-home/core'
import { createProjectAction, type ProjectFormState } from '@/lib/capture/actions'
import { SubmitButton } from '@/components/capture/confirm-submit-button'
import { errorClass, helpClass, inputClass, labelClass } from '@/components/capture/form-styles'

const initial: ProjectFormState = { status: 'idle' }

export function CreateProjectForm() {
  const [state, action] = useActionState(createProjectAction, initial)
  const formRef = useRef<HTMLFormElement>(null)
  const fields = state.status === 'error' ? state.fields : {}

  useEffect(() => {
    if (state.status === 'created') formRef.current?.reset()
  }, [state])

  return (
    <form ref={formRef} action={action} className="space-y-3" noValidate>
      <div>
        <label htmlFor="project-name" className={labelClass}>
          Name
        </label>
        <input
          id="project-name"
          name="name"
          required
          maxLength={120}
          autoComplete="off"
          className={inputClass}
          aria-invalid={fields.name ? true : undefined}
          aria-describedby={fields.name ? 'project-name-error' : undefined}
        />
        {fields.name ? (
          <p id="project-name-error" className={errorClass}>
            {fields.name}
          </p>
        ) : null}
      </div>

      <fieldset>
        <legend className={labelClass}>Kind</legend>
        <div className="flex flex-wrap gap-2">
          {PROJECT_KINDS.map((kind, i) => (
            <label
              key={kind}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-line-strong bg-surface px-3 text-sm text-ink has-[:checked]:border-accent has-[:checked]:bg-accent-soft sm:min-h-10"
            >
              <input type="radio" name="kind" value={kind} defaultChecked={i === 0} />
              {PROJECT_KIND_LABELS[kind]}
            </label>
          ))}
        </div>
        {fields.kind ? <p className={errorClass}>{fields.kind}</p> : null}
      </fieldset>

      <div>
        <label htmlFor="project-goal" className={labelClass}>
          Goal <span className="font-normal text-ink-faint">(optional)</span>
        </label>
        <textarea
          id="project-goal"
          name="goal"
          rows={2}
          maxLength={2000}
          className={`${inputClass} min-h-20`}
          aria-invalid={fields.goal ? true : undefined}
          aria-describedby="project-goal-help"
        />
        <p id="project-goal-help" className={fields.goal ? errorClass : helpClass}>
          {fields.goal ?? 'What finishing this project looks like.'}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="primary" pendingLabel="Creating…">
          Create project
        </SubmitButton>
        <p className="text-sm" role="status" aria-live="polite">
          {state.status === 'created' ? (
            <span className="text-positive">Created “{state.name}”.</span>
          ) : state.status === 'error' ? (
            <span className="text-danger">{state.message}</span>
          ) : null}
        </p>
      </div>
    </form>
  )
}
