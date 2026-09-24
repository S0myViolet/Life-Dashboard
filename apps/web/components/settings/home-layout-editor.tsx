'use client'

import { useActionState } from 'react'
import { ArrowDown, ArrowUp, Eye, EyeOff, Lock } from 'lucide-react'
import {
  HOME_MODULE_DESCRIPTIONS,
  HOME_MODULE_LABELS,
  isRequiredHomeModule,
  type HomeLayout,
  type HomeModule,
} from '@personal-home/core'
import { buttonClass } from '@/components/ui/button'
import { Pill } from '@/components/ui/status-pill'
import { IDLE_STATE } from '@/lib/settings/action-state'
import { changeHomeLayoutAction } from '@/lib/settings/actions'
import { FormMessage } from './settings-list'

const iconButton = buttonClass('secondary', 'size-11 shrink-0 px-0 sm:size-10')

/**
 * Reorder, hide and show Home modules. Every control is a small form posting
 * one operation, so it also works before JavaScript loads. Required modules are
 * locked: always shown, fixed at the top (brief §2: reorder and hide optional
 * modules), so they get no controls and nothing can move above them.
 */
export function HomeLayoutEditor({ layout }: { layout: HomeLayout }) {
  const [state, action, pending] = useActionState(changeHomeLayoutAction, IDLE_STATE)

  const op = (
    fields: Record<string, string>,
    children: React.ReactNode,
    props: {
      label: string
      disabled?: boolean
      className?: string
    },
  ) => (
    <form action={action}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        aria-label={props.label}
        title={props.label}
        disabled={pending || props.disabled}
        className={props.className ?? iconButton}
      >
        {children}
      </button>
    </form>
  )

  return (
    <div className="space-y-4">
      <ol className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
        {layout.map((entry, index) => {
          const mod: HomeModule = entry.module
          const label = HOME_MODULE_LABELS[mod]
          const required = isRequiredHomeModule(mod)
          const previous = layout[index - 1]
          const atTop = !previous || isRequiredHomeModule(previous.module)
          return (
            <li
              key={mod}
              data-module={mod}
              data-hidden={entry.hidden ? 'true' : 'false'}
              className={`flex flex-wrap items-center gap-3 p-3 sm:flex-nowrap sm:p-4 ${
                entry.hidden ? 'bg-surface-muted/60' : ''
              }`}
            >
              <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`text-[15px] font-medium ${entry.hidden ? 'text-ink-muted' : 'text-ink'}`}
                  >
                    {label}
                  </span>
                  {required ? (
                    <Pill>
                      <Lock aria-hidden className="size-3" /> Always shown at the top
                    </Pill>
                  ) : entry.hidden ? (
                    <Pill tone="caution">Hidden</Pill>
                  ) : null}
                </div>
                <p className="mt-0.5 text-sm text-ink-muted">{HOME_MODULE_DESCRIPTIONS[mod]}</p>
              </div>
              {required ? null : (
                <div className="flex items-center gap-2">
                  {op(
                    { op: 'move', module: mod, direction: 'up' },
                    <ArrowUp aria-hidden className="size-4" />,
                    { label: `Move ${label} up`, disabled: atTop },
                  )}
                  {op(
                    { op: 'move', module: mod, direction: 'down' },
                    <ArrowDown aria-hidden className="size-4" />,
                    { label: `Move ${label} down`, disabled: index === layout.length - 1 },
                  )}
                  {entry.hidden
                    ? op({ op: 'show', module: mod }, <Eye aria-hidden className="size-4" />, {
                        label: `Show ${label}`,
                      })
                    : op({ op: 'hide', module: mod }, <EyeOff aria-hidden className="size-4" />, {
                        label: `Hide ${label}`,
                      })}
                </div>
              )}
            </li>
          )
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        {op({ op: 'reset' }, 'Reset to default order', {
          label: 'Reset Home layout to the default order',
          className: buttonClass('ghost'),
        })}
        <FormMessage state={state} />
      </div>
    </div>
  )
}
