'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BOTTOM_ITEMS, SIDEBAR_ITEMS, isActive } from './nav-items'

export function Sidebar() {
  const pathname = usePathname()
  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {SIDEBAR_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href)
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
              active
                ? 'bg-accent-soft font-medium text-accent-strong'
                : 'text-ink-muted hover:bg-surface-muted hover:text-ink'
            }`}
          >
            <Icon aria-hidden className="size-[18px]" strokeWidth={1.8} />
            {label}
          </Link>
        )
      })}
    </nav>
  )
}

export function BottomNav() {
  const pathname = usePathname()
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85 md:hidden"
      style={{ paddingBottom: 'var(--safe-bottom)' }}
    >
      <ul className="mx-auto grid max-w-lg grid-cols-5">
        {BOTTOM_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href)
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] ${
                  active ? 'font-semibold text-accent-strong' : 'text-ink-muted'
                }`}
              >
                <Icon aria-hidden className="size-[22px]" strokeWidth={active ? 2.1 : 1.8} />
                {label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
