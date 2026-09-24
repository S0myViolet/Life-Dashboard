'use client'

/**
 * Small form and feedback pieces shared by the tasks, habits and reminders
 * screens. Inputs are at least 44px tall on phones; errors are tied to their
 * inputs with aria-describedby.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { TasksFormState } from '@/lib/tasks/forms'

export const inputClass =
  'mt-1 block min-h-11 w-full min-w-0 rounded-xl border border-line-strong bg-surface px-3 text-[15px] text-ink placeholder:text-ink-faint aria-[invalid=true]:border-danger'
export const labelClass = 'block text-sm font-medium text-ink'
export const helpClass = 'mt-1 text-sm text-ink-muted'

export function fieldIds(prefix: string, name: string) {
  return { id: `${prefix}-${name}`, errorId: `${prefix}-${name}-error` }
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <p id={id} className="mt-1 text-sm text-danger">
      {message}
    </p>
  )
}

/** The outcome of a form submission: a polite status or an alert. */
export function FormStatus({ state }: { state: TasksFormState }) {
  if (state.status === 'saved') {
    return (
      <p role="status" className="text-sm text-positive">
        {state.message}
        {state.notice ? <span className="mt-1 block text-ink-muted">{state.notice}</span> : null}
      </p>
    )
  }
  if (state.status === 'error') {
    return (
      <p role="alert" className="text-sm text-danger">
        {state.message}
      </p>
    )
  }
  return null
}

export interface ToastMessage {
  id: number
  message: string
  tone?: 'neutral' | 'error'
  action?: { label: string; run: () => void }
}

/** One toast at a time, announced politely; stays while it has focus or the pointer. */
export function useToast(timeoutMs = 8000) {
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const counter = useRef(0)
  const show = useCallback((t: Omit<ToastMessage, 'id'>) => {
    counter.current += 1
    setToast({ ...t, id: counter.current })
  }, [])
  const dismiss = useCallback(() => setToast(null), [])
  return { toast, show, dismiss, timeoutMs }
}

export function Toast({
  toast,
  dismiss,
  timeoutMs,
}: {
  toast: ToastMessage | null
  dismiss: () => void
  timeoutMs: number
}) {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!toast || held) return
    const timer = setTimeout(dismiss, timeoutMs)
    return () => clearTimeout(timer)
  }, [toast, held, dismiss, timeoutMs])

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+var(--safe-bottom))] z-40 flex justify-center px-4 md:bottom-6">
      <div role="status" aria-live="polite" className="w-full max-w-md">
        {toast ? (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-center gap-2 rounded-xl border px-3 py-2 text-sm shadow-lg ${
              toast.tone === 'error'
                ? 'border-danger/30 bg-danger-soft text-danger'
                : 'border-line-strong bg-ink text-white'
            }`}
            onFocus={() => setHeld(true)}
            onBlur={() => setHeld(false)}
            onPointerEnter={() => setHeld(true)}
            onPointerLeave={() => setHeld(false)}
          >
            <span className="min-w-0 flex-1">{toast.message}</span>
            {toast.action ? (
              <button
                type="button"
                className="min-h-11 shrink-0 rounded-lg px-3 font-semibold underline-offset-2 hover:underline"
                onClick={() => {
                  toast.action?.run()
                  dismiss()
                }}
              >
                {toast.action.label}
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Dismiss message"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg opacity-80 hover:opacity-100"
              onClick={dismiss}
            >
              <X aria-hidden className="size-4" />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * A modal sheet on the native <dialog> element: focus is trapped, Escape
 * closes it and focus returns to the opener. Bottom sheet on phones, centred
 * panel on larger screens.
 */
export function Sheet({
  open,
  onClose,
  title,
  titleId,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  titleId: string
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const opener = useRef<Element | null>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      opener.current = document.activeElement
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const handleClose = () => {
      onClose()
      const el = opener.current
      if (el instanceof HTMLElement && el.isConnected) el.focus()
    }
    dialog.addEventListener('close', handleClose)
    return () => dialog.removeEventListener('close', handleClose)
  }, [onClose])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-2xl border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-ink/30 sm:inset-0 sm:m-auto sm:h-fit sm:max-w-lg sm:rounded-2xl"
    >
      {open ? (
        <div className="p-4 sm:p-5" style={{ paddingBottom: 'max(1rem, var(--safe-bottom))' }}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id={titleId} className="text-lg font-semibold tracking-tight">
              {title}
            </h2>
            <button
              type="button"
              aria-label="Close"
              className="inline-flex size-11 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-muted hover:text-ink"
              onClick={() => ref.current?.close()}
            >
              <X aria-hidden className="size-5" />
            </button>
          </div>
          {children}
        </div>
      ) : null}
    </dialog>
  )
}
