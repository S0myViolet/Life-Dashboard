'use client'

/**
 * Quick capture: Task, Reading, Note and Journal as keyboard-operable tabs (arrow keys, Home and
 * End move between tabs; Tab moves into the panel). Only the chosen panel is rendered.
 */
import Link from 'next/link'
import { useRef, useState } from 'react'
import { BookOpen, CheckSquare, Mic, PenLine } from 'lucide-react'
import { buttonClass } from '@/components/ui/button'
import { NoteCapture } from './note-capture'
import { ReadingCapture, type QuickCaptureBook } from './reading-capture'
import { TaskCapture } from './task-capture'

const TABS = [
  { key: 'task', label: 'Task', icon: CheckSquare },
  { key: 'reading', label: 'Reading', icon: BookOpen },
  { key: 'note', label: 'Note', icon: PenLine },
  { key: 'journal', label: 'Journal', icon: Mic },
] as const
type TabKey = (typeof TABS)[number]['key']

export function QuickCaptureTabs({
  today,
  tomorrow,
  tz,
  books,
}: {
  today: string
  tomorrow: string
  tz: string
  books: QuickCaptureBook[]
}) {
  const [tab, setTab] = useState<TabKey>('task')
  // After the owner switches tabs, move focus into the new panel's first field.
  const [switched, setSwitched] = useState(false)
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  function choose(next: TabKey, focusTab: boolean) {
    setTab(next)
    setSwitched(true)
    if (focusTab) tabRefs.current[next]?.focus()
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = TABS.findIndex((t) => t.key === tab)
    let next: number | null = null
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABS.length - 1
    if (next === null) return
    event.preventDefault()
    choose(TABS[next]!.key, true)
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="What to capture"
        onKeyDown={onKeyDown}
        className="grid grid-cols-4 gap-1 rounded-xl bg-surface-muted p-1"
      >
        {TABS.map((t) => {
          const Icon = t.icon
          const selected = t.key === tab
          return (
            <button
              key={t.key}
              ref={(el) => {
                tabRefs.current[t.key] = el
              }}
              type="button"
              role="tab"
              id={`qc-tab-${t.key}`}
              aria-selected={selected}
              aria-controls={`qc-panel-${t.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => choose(t.key, false)}
              className={`inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-lg px-1 text-sm font-medium transition-colors sm:min-h-10 ${
                selected
                  ? 'bg-surface text-ink shadow-[var(--shadow-card)]'
                  : 'text-ink-muted hover:text-ink'
              }`}
            >
              <Icon aria-hidden className="hidden size-4 shrink-0 sm:block" strokeWidth={1.8} />
              <span className="truncate">{t.label}</span>
            </button>
          )
        })}
      </div>
      <div
        role="tabpanel"
        id={`qc-panel-${tab}`}
        aria-labelledby={`qc-tab-${tab}`}
        className="mt-3"
      >
        {tab === 'task' ? (
          <TaskCapture today={today} tomorrow={tomorrow} tz={tz} autoFocus={switched} />
        ) : tab === 'reading' ? (
          <ReadingCapture books={books} />
        ) : tab === 'note' ? (
          <NoteCapture />
        ) : (
          <div className="space-y-2 text-sm text-ink-muted" data-testid="quick-journal">
            <p>
              Type today&rsquo;s entry or record it; recordings are transcribed for you to edit.
            </p>
            <Link href="/capture/journal" className={buttonClass('primary')}>
              <Mic aria-hidden className="size-4" />
              Open today&rsquo;s journal
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
