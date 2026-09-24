'use client'

import { useFormStatus } from 'react-dom'
import { buttonClass } from '@/components/ui/button'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

/**
 * Submit button for a Server Action form. With `confirm`, asks first and
 * cancels the submission when the owner says no (used for destructive actions).
 */
export function SubmitButton({
  children,
  variant = 'secondary',
  confirm,
  pendingLabel,
  className = '',
  ariaLabel,
}: {
  children: React.ReactNode
  variant?: Variant
  confirm?: string
  pendingLabel?: string
  className?: string
  ariaLabel?: string
}) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      aria-label={ariaLabel}
      disabled={pending}
      aria-disabled={pending}
      className={buttonClass(variant, className)}
      onClick={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault()
      }}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  )
}
