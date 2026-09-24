import 'server-only'
import { groupTimezonesForPicker } from '@personal-home/core'
import { listTimezoneNames, type Tx } from '@personal-home/db'

let cached: Promise<{ region: string; zones: string[] }[]> | undefined

/**
 * Picker groups built from the database's own zone list, so every option can
 * be saved (the owner_settings trigger validates against pg_timezone_names).
 * The list only changes with a Postgres tzdata upgrade, so it is cached per
 * server instance.
 */
export function timezonePickerGroups(tx: Tx): Promise<{ region: string; zones: string[] }[]> {
  cached ??= listTimezoneNames(tx)
    .then(groupTimezonesForPicker)
    .catch((error: unknown) => {
      cached = undefined
      throw error
    })
  return cached
}
