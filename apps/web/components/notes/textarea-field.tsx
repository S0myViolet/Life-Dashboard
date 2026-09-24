import { useId, type ReactNode, type TextareaHTMLAttributes } from 'react'

const TEXTAREA_CLASS = 'mt-1 block w-full rounded-xl border border-line-strong bg-surface text-ink'

/**
 * A textarea with an explicitly associated label (htmlFor/id). Wrapping a textarea in its label
 * makes the server-rendered text part of the label's text, which confuses label lookups.
 */
export function TextareaField({
  label,
  className = 'p-3 text-sm',
  wrapperClassName = '',
  ...props
}: { label: ReactNode; wrapperClassName?: string } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId()
  return (
    <div className={wrapperClassName}>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <textarea id={id} {...props} className={`${TEXTAREA_CLASS} ${className}`} />
    </div>
  )
}
