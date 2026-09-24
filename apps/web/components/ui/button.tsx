import Link from 'next/link'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const base =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-10'

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-strong',
  secondary: 'border border-line-strong bg-surface text-ink hover:bg-surface-muted',
  ghost: 'text-ink-muted hover:bg-surface-muted hover:text-ink',
  danger: 'border border-danger/30 bg-danger-soft text-danger hover:bg-danger-soft/70',
}

export function buttonClass(variant: Variant = 'secondary', extra = '') {
  return `${base} ${variants[variant]} ${extra}`
}

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button className={buttonClass(variant, className)} {...props} />
}

export function ButtonLink({
  variant = 'secondary',
  className = '',
  href,
  children,
}: {
  variant?: Variant
  className?: string
  href: string
  children: React.ReactNode
}) {
  return (
    <Link href={href} className={buttonClass(variant, className)}>
      {children}
    </Link>
  )
}
