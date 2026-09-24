'use client'

import { useActionState } from 'react'
import { timezonePickerLabel } from '@personal-home/core'
import { buttonClass } from '@/components/ui/button'
import { IDLE_STATE } from '@/lib/settings/action-state'
import { saveTimezoneAction } from '@/lib/settings/actions'
import { useDeviceTimezone } from '@/lib/settings/use-device-timezone'
import { FormMessage } from './settings-list'

export function TimezoneForm({
  current,
  confirmed,
  groups,
}: {
  current: string
  /** False until the owner has explicitly confirmed or chosen a timezone. */
  confirmed: boolean
  groups: { region: string; zones: string[] }[]
}) {
  const [state, action, pending] = useActionState(saveTimezoneAction, IDLE_STATE)
  const device = useDeviceTimezone()
  const known = groups.some((g) => g.zones.includes(current))
  const fieldError = state.status === 'error' ? state.fieldErrors?.timezone : undefined

  return (
    <div className="space-y-5">
      {typeof device === 'string' && device !== current ? (
        <form action={action} className="rounded-xl border border-line bg-surface-muted/60 p-3">
          <input type="hidden" name="timezone" value={device} />
          <p className="text-sm text-ink-muted">
            This device is set to <strong className="text-ink">{device}</strong>.
          </p>
          <button type="submit" className={buttonClass('secondary', 'mt-2')} disabled={pending}>
            Use {device}
          </button>
        </form>
      ) : null}

      <form action={action} className="space-y-3">
        <div>
          <label htmlFor="timezone" className="block text-sm font-medium text-ink">
            Timezone
          </label>
          {/*
            key={current}: React resets a form after its action runs, restoring each
            <option>'s defaultSelected from the first render — and it never re-applies a
            changed defaultValue (a controlled value does not survive the reset either).
            Without a remount the picker fell back to the first-rendered zone after a save,
            and pressing Save again silently reverted the saved timezone.
          */}
          <select
            key={current}
            id="timezone"
            name="timezone"
            defaultValue={current}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? 'timezone-error' : 'timezone-help'}
            className="mt-1 block min-h-11 w-full rounded-xl border border-line-strong bg-surface px-3 text-[15px] text-ink sm:max-w-md"
          >
            {known ? null : <option value={current}>{current}</option>}
            {groups.map((group) => (
              <optgroup key={group.region} label={group.region}>
                {group.zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {group.region === 'UTC' ? 'UTC' : timezonePickerLabel(zone)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {fieldError ? (
            <p id="timezone-error" className="mt-1 text-sm text-danger">
              {fieldError}
            </p>
          ) : (
            <p id="timezone-help" className="mt-1 text-sm text-ink-muted">
              Pick the city whose clock you live by. It stays fixed until you change it here, even
              when you travel.
            </p>
          )}
        </div>
        <button type="submit" className={buttonClass('primary')} disabled={pending}>
          {pending ? 'Saving…' : confirmed ? 'Save timezone' : 'Confirm timezone'}
        </button>
        <FormMessage state={state} />
      </form>
    </div>
  )
}
