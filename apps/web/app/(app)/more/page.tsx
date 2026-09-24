import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { PageHeader } from '@/components/shell/app-shell'
import { MORE_ITEMS } from '@/components/shell/nav-items'
import { requireOwner } from '@/lib/server/session'

export const metadata = { title: 'More' }

export default async function MorePage() {
  await requireOwner()
  return (
    <>
      <PageHeader title="More" />
      <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
        {MORE_ITEMS.map(({ href, label, icon: Icon }) => (
          <li key={href}>
            <Link
              href={href}
              className="flex min-h-14 items-center gap-3 px-4 text-[15px] text-ink hover:bg-surface-muted"
            >
              <Icon aria-hidden className="size-5 text-ink-muted" strokeWidth={1.8} />
              <span className="flex-1">{label}</span>
              <ChevronRight aria-hidden className="size-4 text-ink-faint" />
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}
