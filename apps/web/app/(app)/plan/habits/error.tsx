'use client'

import { buttonClass } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

export default function HabitsError({
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  return (
    <Card>
      <h1 className="text-lg font-semibold tracking-tight text-ink">Habits could not be loaded</h1>
      <p role="alert" className="mt-2 text-sm text-ink-muted">
        Something went wrong while loading this page. Your habits and their history are unchanged.
      </p>
      <button type="button" className={buttonClass('secondary', 'mt-3')} onClick={() => retry()}>
        Try again
      </button>
    </Card>
  )
}
