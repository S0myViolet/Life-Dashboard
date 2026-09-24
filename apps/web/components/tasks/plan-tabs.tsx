import Link from 'next/link'

const TABS = [
  { key: 'plan', href: '/plan', label: 'Overview' },
  { key: 'tasks', href: '/plan/tasks', label: 'Tasks' },
  { key: 'habits', href: '/plan/habits', label: 'Habits' },
] as const

/** Secondary navigation inside Plan. */
export function PlanTabs({ current }: { current: 'tasks' | 'habits' }) {
  return (
    <nav aria-label="Plan sections" className="-mt-2 mb-5 overflow-x-auto">
      <ul className="flex gap-1 border-b border-line">
        {TABS.map((tab) => {
          const active = tab.key === current
          return (
            <li key={tab.key}>
              <Link
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={`-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-sm ${
                  active
                    ? 'border-accent font-semibold text-accent-strong'
                    : 'border-transparent text-ink-muted hover:text-ink'
                }`}
              >
                {tab.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
