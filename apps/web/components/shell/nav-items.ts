import {
  BookOpen,
  CalendarDays,
  Ellipsis,
  FolderKanban,
  HeartPulse,
  House,
  Newspaper,
  PenLine,
  Settings,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
}

/** Desktop sidebar, in order. */
export const SIDEBAR_ITEMS: NavItem[] = [
  { href: '/', label: 'Home', icon: House },
  { href: '/plan', label: 'Plan', icon: CalendarDays },
  { href: '/projects', label: 'Projects', icon: FolderKanban },
  { href: '/capture', label: 'Capture', icon: PenLine },
  { href: '/updates', label: 'Updates', icon: Newspaper },
  { href: '/money', label: 'Money', icon: Wallet },
  { href: '/health', label: 'Health', icon: HeartPulse },
  { href: '/learning', label: 'Learning', icon: BookOpen },
  { href: '/people', label: 'People', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
]

/** Mobile bottom navigation: five destinations, the rest live under More. */
export const BOTTOM_ITEMS: NavItem[] = [
  { href: '/', label: 'Home', icon: House },
  { href: '/plan', label: 'Plan', icon: CalendarDays },
  { href: '/capture', label: 'Capture', icon: PenLine },
  { href: '/updates', label: 'Updates', icon: Newspaper },
  { href: '/more', label: 'More', icon: Ellipsis },
]

export const MORE_ITEMS: NavItem[] = SIDEBAR_ITEMS.filter((i) =>
  ['/projects', '/money', '/health', '/learning', '/people', '/settings'].includes(i.href),
)

export function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  if (href === '/more')
    return MORE_ITEMS.some((i) => pathname.startsWith(i.href)) || pathname.startsWith('/more')
  return pathname === href || pathname.startsWith(`${href}/`)
}
