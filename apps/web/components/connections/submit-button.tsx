'use client'

import { useFormStatus } from 'react-dom'
import { Button } from '@/components/ui/button'

/** Submit button that disables itself and says what is happening while its form's action runs. */
export function SubmitButton({
  children,
  pendingLabel,
  variant = 'secondary',
  className = '',
  name,
  value,
}: {
  children: React.ReactNode
  pendingLabel: string
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  className?: string
  name?: string
  value?: string
}) {
  const { pending } = useFormStatus()
  return (
    <Button
      type="submit"
      variant={variant}
      className={className}
      disabled={pending}
      aria-disabled={pending}
      name={name}
      value={value}
    >
      {pending ? pendingLabel : children}
    </Button>
  )
}
