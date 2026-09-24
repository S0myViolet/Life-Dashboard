'use client'

import { startTransition, useActionState, useEffect, useRef, useState } from 'react'
import { buttonClass } from '@/components/ui/button'
import type { FormActionState } from './form-state'

type Action = (previous: FormActionState, formData: FormData) => Promise<FormActionState>
type SavedState = Extract<FormActionState, { status: 'saved' }>

/**
 * useActionState for forms that should keep what was typed when the server rejects it.
 *
 * React resets uncontrolled fields after every function action, including one that
 * returns a validation error. Once hydrated we submit through startTransition instead
 * (no automatic reset) and reset only after a successful save. Without JavaScript the
 * plain `action` still posts the form (progressive enhancement).
 */
export function useFormAction(
  action: Action,
  options: {
    resetOnSave?: boolean
    /** Runs after each successful save (after the reset, when resetting). */
    onSaved?: (state: SavedState, form: HTMLFormElement) => void
  } = {},
) {
  const resetOnSave = options.resetOnSave ?? true
  const [state, formAction, pending] = useActionState(action, { status: 'idle' })
  const ref = useRef<HTMLFormElement>(null)
  const handled = useRef<FormActionState>(state)
  const onSaved = useRef(options.onSaved)

  useEffect(() => {
    onSaved.current = options.onSaved
  })

  useEffect(() => {
    if (state === handled.current) return
    handled.current = state
    const form = ref.current
    if (state.status !== 'saved' || !form) return
    if (resetOnSave) form.reset()
    onSaved.current?.(state, form)
  }, [state, resetOnSave])

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const submitter = (event.nativeEvent as SubmitEvent).submitter
    const formData = new FormData(event.currentTarget, submitter)
    startTransition(() => formAction(formData))
  }

  return { state, pending, formProps: { ref, action: formAction, onSubmit } }
}

export function fieldError(state: FormActionState, name: string): string | undefined {
  return state.status === 'error' ? state.fieldErrors?.[name] : undefined
}

/** Accessible attributes for an input that may carry an error. */
export function fieldAria(state: FormActionState, id: string, name: string, hintId?: string) {
  const error = fieldError(state, name)
  return {
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${id}-error` : hintId,
  } as const
}

export function FieldError({
  state,
  id,
  name,
}: {
  state: FormActionState
  id: string
  name: string
}) {
  const error = fieldError(state, name)
  return error ? (
    <p id={`${id}-error`} className="mt-1 text-sm text-danger">
      {error}
    </p>
  ) : null
}

/** Result line for a form: success in green, errors in red; announced politely. */
export function FormMessage({ state }: { state: FormActionState }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={`min-h-5 text-sm ${
        state.status === 'error' ? 'text-danger' : state.status === 'saved' ? 'text-positive' : ''
      }`}
    >
      {state.status === 'idle' ? '' : state.message}
    </p>
  )
}

export function SubmitButton({
  pending,
  children,
  pendingLabel = 'Saving…',
  variant = 'primary',
  className = '',
}: {
  pending: boolean
  children: React.ReactNode
  pendingLabel?: string
  variant?: 'primary' | 'secondary'
  className?: string
}) {
  return (
    <button type="submit" className={buttonClass(variant, className)} disabled={pending}>
      {pending ? pendingLabel : children}
    </button>
  )
}

/**
 * Two-step destructive button: the first press asks, the second does it. Works with a
 * server action bound to the thing being deleted.
 */
export function ConfirmDeleteButton({
  action,
  label,
  confirmLabel,
  question,
}: {
  action: () => Promise<void>
  label: string
  confirmLabel: string
  question: string
}) {
  const [asking, setAsking] = useState(false)
  const [pending, setPending] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const askRef = useRef<HTMLButtonElement>(null)
  const wasAsking = useRef(false)

  // Keep keyboard focus on the control that replaced the one just pressed.
  useEffect(() => {
    if (asking) confirmRef.current?.focus()
    else if (wasAsking.current) askRef.current?.focus()
    wasAsking.current = asking
  }, [asking])

  if (!asking) {
    return (
      <button
        ref={askRef}
        type="button"
        className={buttonClass('ghost')}
        onClick={() => setAsking(true)}
      >
        {label}
      </button>
    )
  }
  return (
    <div role="group" aria-label={question} className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-ink">{question}</span>
      <form
        action={async () => {
          setPending(true)
          try {
            await action()
          } finally {
            setPending(false)
          }
        }}
      >
        <button ref={confirmRef} type="submit" className={buttonClass('danger')} disabled={pending}>
          {pending ? 'Deleting…' : confirmLabel}
        </button>
      </form>
      <button type="button" className={buttonClass('ghost')} onClick={() => setAsking(false)}>
        Cancel
      </button>
    </div>
  )
}
