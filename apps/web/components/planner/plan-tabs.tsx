import Link from 'next/link'

export type PlanTab = 'day' | 'week' | 'tasks' | 'habits'

const TABS: Array<{ key: PlanTab; href: string; label: string }> = [
  { key: 'day', href: '/plan', label: 'Day' },
  { key: 'week', href: '/plan/week', label: 'Week' },
  { key: 'tasks', href: '/plan/tasks', label: 'Tasks' },
  { key: 'habits', href: '/plan/habits', label: 'Habits' },
]

/** Section navigation for the Plan area (Day | Week | Tasks | Habits). */
export function PlanTabs({ active }: { active: PlanTab }) {
  return (
    <nav aria-label="Plan views" className="mb-5">
      <ul className="inline-flex max-w-full gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1">
        {TABS.map((t) => {
          const current = t.key === active
          return (
            <li key={t.key}>
              <Link
                href={t.href}
                aria-current={current ? 'page' : undefined}
                className={`inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-medium sm:min-h-9 ${
                  current
                    ? 'bg-accent text-white'
                    : 'text-ink-muted hover:bg-surface-muted hover:text-ink'
                }`}
              >
                {t.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
