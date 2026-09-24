import Link from 'next/link'
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react'
import { PageHeader } from '@/components/shell/app-shell'

/** A titled group of settings rows (iOS-style list, comfortable on phones). */
export function SettingsGroup({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  const id = `settings-group-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    <section aria-labelledby={id} className="mb-6">
      <h2 id={id} className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
        {title}
      </h2>
      <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
        {children}
      </ul>
    </section>
  )
}

export function SettingsRow({
  href,
  label,
  value,
  icon: Icon,
}: {
  href: string
  label: string
  value?: React.ReactNode
  icon: LucideIcon
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex min-h-14 items-center gap-3 px-4 py-2 text-[15px] text-ink hover:bg-surface-muted"
      >
        <Icon aria-hidden className="size-5 shrink-0 text-ink-muted" strokeWidth={1.8} />
        <span className="min-w-0 flex-1">
          <span className="block">{label}</span>
          {value ? <span className="block truncate text-sm text-ink-muted">{value}</span> : null}
        </span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-faint" />
      </Link>
    </li>
  )
}

/** Heading for a settings subpage, with a way back to the Settings list. */
export function SettingsSubpageHeader({
  title,
  subtitle,
}: {
  title: string
  subtitle?: React.ReactNode
}) {
  return (
    <>
      <Link
        href="/settings"
        className="-ml-1 mb-2 inline-flex min-h-11 items-center gap-1 rounded-md px-1 text-sm text-accent hover:text-accent-strong sm:min-h-0"
      >
        <ChevronLeft aria-hidden className="size-4" />
        Settings
      </Link>
      <PageHeader title={title} subtitle={subtitle} />
    </>
  )
}

/** Polite live region for a form's saved/error message. */
export function FormMessage({
  state,
}: {
  state: { status: 'idle' } | { status: 'saved' | 'error'; message: string }
}) {
  return (
    <p aria-live="polite" role="status" className="min-h-5 text-sm">
      {state.status === 'saved' ? <span className="text-positive">{state.message}</span> : null}
      {state.status === 'error' ? <span className="text-danger">{state.message}</span> : null}
    </p>
  )
}
