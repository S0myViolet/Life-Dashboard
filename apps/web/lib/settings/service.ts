/**
 * Settings mutations behind the server actions. Each function takes an owner
 * transaction (RLS-enforced) and untrusted FormData, validates it with zod and
 * returns a SettingsActionState. Kept separate from actions.ts so it can be
 * tested against a real database without a Next.js request.
 */
import 'server-only'
import { z } from 'zod'
import {
  AvailableHoursSchema,
  HOME_MODULE_LABELS,
  HomeLayoutOperationSchema,
  OwnerTimezoneSchema,
} from '@personal-home/core'
import {
  SettingsTimezoneNotRecognisedError,
  changeHomeLayout,
  updateAvailableHours,
  updateTimezone,
  type Tx,
} from '@personal-home/db'
import type { SettingsActionState } from './action-state'

const NOT_OWNER: SettingsActionState = {
  status: 'error',
  message: 'Only the owner can change settings.',
}

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name)
  return typeof value === 'string' ? value : undefined
}

const TimezoneFormSchema = z.object({ timezone: OwnerTimezoneSchema })

/** Save (and confirm) the owner's timezone: from the device suggestion or the picker. */
export async function saveTimezoneFromForm(
  tx: Tx,
  formData: FormData,
): Promise<SettingsActionState> {
  const parsed = TimezoneFormSchema.safeParse({ timezone: field(formData, 'timezone') ?? '' })
  if (!parsed.success) {
    return {
      status: 'error',
      message: 'Choose a timezone from the list.',
      fieldErrors: { timezone: parsed.error.issues[0]?.message ?? 'Invalid timezone' },
    }
  }
  try {
    const saved = await updateTimezone(tx, parsed.data.timezone, true)
    if (!saved) return NOT_OWNER
    return { status: 'saved', message: `Timezone set to ${saved.timezone}.` }
  } catch (error) {
    if (error instanceof SettingsTimezoneNotRecognisedError) {
      return {
        status: 'error',
        message: `The server does not recognise ${parsed.data.timezone}. Choose the nearest city from the list.`,
        fieldErrors: { timezone: 'Not recognised by the server' },
      }
    }
    throw error
  }
}

/** One reorder/hide/show/reset operation on the Home layout. */
export async function changeHomeLayoutFromForm(
  tx: Tx,
  formData: FormData,
): Promise<SettingsActionState> {
  const raw: Record<string, string> = {}
  for (const name of ['op', 'module', 'direction']) {
    const value = field(formData, name)
    if (value !== undefined && value !== '') raw[name] = value
  }
  const parsed = HomeLayoutOperationSchema.safeParse(raw)
  if (!parsed.success) return { status: 'error', message: 'That layout change is not valid.' }
  const result = await changeHomeLayout(tx, parsed.data)
  if (result.status === 'not_owner') return NOT_OWNER
  if (result.status === 'required_module') {
    const label = 'module' in parsed.data ? HOME_MODULE_LABELS[parsed.data.module] : 'This module'
    const message =
      parsed.data.op === 'move'
        ? `${label} stays at the top of Home.`
        : `${label} always stays on Home.`
    return { status: 'error', message }
  }
  const op = parsed.data
  const message =
    op.op === 'reset'
      ? 'Home layout reset.'
      : op.op === 'move'
        ? `${HOME_MODULE_LABELS[op.module]} moved ${op.direction}.`
        : `${HOME_MODULE_LABELS[op.module]} ${op.op === 'hide' ? 'hidden' : 'shown'}.`
  return { status: 'saved', message }
}

/** Max size of the JSON the hours editor submits (42 slots is well under 4 KB). */
const MAX_HOURS_JSON = 8_192

/**
 * Replace available hours. The editor submits `hours` as JSON
 * ([{ weekday, start, end }]); an empty list clears them.
 */
export async function saveAvailableHoursFromForm(
  tx: Tx,
  formData: FormData,
): Promise<SettingsActionState> {
  const json = field(formData, 'hours') ?? ''
  if (json.length === 0 || json.length > MAX_HOURS_JSON) {
    return { status: 'error', message: 'The hours could not be read. Please try again.' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return { status: 'error', message: 'The hours could not be read. Please try again.' }
  }
  const parsed = AvailableHoursSchema.safeParse(raw)
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {}
    for (const issue of parsed.error.issues) {
      const index = issue.path[0]
      const key = typeof index === 'number' ? String(index) : 'form'
      fieldErrors[key] ??= issue.message
    }
    return { status: 'error', message: 'Some time ranges need fixing.', fieldErrors }
  }
  const saved = await updateAvailableHours(tx, parsed.data)
  if (!saved) return NOT_OWNER
  return {
    status: 'saved',
    message: saved.availableHours ? 'Available hours saved.' : 'Available hours cleared.',
  }
}
