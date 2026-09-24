export function EmptyState({
  title,
  children,
  action,
}: {
  title: string
  children?: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-dashed border-line-strong bg-surface-muted/60 px-4 py-5 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {children ? (
        <div className="mx-auto mt-1 max-w-prose text-sm text-ink-muted">{children}</div>
      ) : null}
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  )
}
