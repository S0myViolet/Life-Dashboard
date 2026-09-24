import Link from 'next/link'
import { ChevronRight } from 'lucide-react'

export function Card({
  children,
  className = '',
  as: Tag = 'section',
  ...rest
}: {
  children: React.ReactNode
  className?: string
  as?: 'section' | 'div' | 'article'
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={`rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5 ${className}`}
      {...rest}
    >
      {children}
    </Tag>
  )
}

/** Section heading with an optional "see all" route, so previews stay short. */
export function CardHeader({
  title,
  id,
  href,
  hrefLabel = 'See all',
  meta,
}: {
  title: string
  id?: string
  href?: string
  hrefLabel?: string
  meta?: React.ReactNode
}) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 id={id} className="truncate text-[15px] font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {meta ? <div className="shrink-0 text-xs text-ink-faint">{meta}</div> : null}
      </div>
      {href ? (
        <Link
          href={href}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 text-sm text-accent hover:text-accent-strong"
        >
          {hrefLabel}
          <ChevronRight aria-hidden className="size-4" />
        </Link>
      ) : null}
    </div>
  )
}
