import Link from 'next/link'
import { BottomNav, Sidebar } from './app-nav'

/**
 * Authenticated frame: compact sidebar on desktop, five-item bottom bar on phones.
 * Pages render their own heading via <PageHeader>.
 */
export function AppShell({
  children,
  banner,
}: {
  children: React.ReactNode
  banner?: React.ReactNode
}) {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[13.5rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh flex-col gap-6 border-r border-line bg-surface/60 px-3 py-5 md:flex">
        <Link href="/" className="px-3 text-[15px] font-semibold tracking-tight text-ink">
          Personal Home
        </Link>
        <Sidebar />
        <form action="/auth/signout" method="post" className="mt-auto px-1">
          <button
            type="submit"
            className="w-full rounded-lg px-2 py-2 text-left text-sm text-ink-faint hover:bg-surface-muted hover:text-ink"
          >
            Sign out
          </button>
        </form>
      </aside>
      <div className="min-w-0">
        {banner}
        <main
          id="main"
          className="mx-auto w-full max-w-5xl px-4 pb-28 pt-5 sm:px-6 md:pb-12 md:pt-8"
          style={{ paddingTop: 'max(1.25rem, var(--safe-top))' }}
        >
          {children}
        </main>
      </div>
      <BottomNav />
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3 sm:mb-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-[28px]">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-ink-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  )
}
