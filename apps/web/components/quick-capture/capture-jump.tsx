'use client'

/**
 * "Capture" in Home's header: scrolls to quick capture and puts the cursor in its first field,
 * so a thought can be captured with two keystrokes. A plain anchor without JavaScript.
 */
import { PenLine } from 'lucide-react'
import { buttonClass } from '@/components/ui/button'

export function CaptureJump({ targetId }: { targetId: string }) {
  return (
    <a
      href={`#${targetId}`}
      className={buttonClass('secondary', 'px-3')}
      onClick={(event) => {
        const section = document.getElementById(targetId)
        const field = section?.querySelector<HTMLElement>(
          '[role="tabpanel"]:not([hidden]) :is(input:not([type="hidden"]), textarea, select)',
        )
        if (!section || !field) return
        event.preventDefault()
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })
        field.focus({ preventScroll: true })
      }}
    >
      <PenLine aria-hidden className="size-4" strokeWidth={1.8} />
      Capture
    </a>
  )
}
