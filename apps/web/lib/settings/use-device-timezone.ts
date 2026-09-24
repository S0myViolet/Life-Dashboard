'use client'

import { useSyncExternalStore } from 'react'
import { ownerTimezoneIsValid, ownerTimezonePrimaryName } from '@personal-home/core'

const subscribe = () => () => {}

function readDeviceTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return tz && ownerTimezoneIsValid(tz) ? ownerTimezonePrimaryName(tz) : null
  } catch {
    return null
  }
}

/**
 * The device's IANA timezone, in its IANA primary spelling (Chrome reports
 * legacy names such as Asia/Calcutta). 'pending' during server rendering and
 * hydration; null when the browser does not report a usable zone.
 * Reading it never saves anything.
 */
export function useDeviceTimezone(): string | null | 'pending' {
  return useSyncExternalStore(subscribe, readDeviceTimezone, () => 'pending' as const)
}
