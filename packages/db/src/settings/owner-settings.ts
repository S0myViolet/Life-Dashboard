/**
 * Owner settings repository (public.owner_settings, a singleton row).
 *
 * All functions take an owner transaction (withOwner): Row Level Security
 * decides visibility, so a non-owner gets `null` back and anon gets
 * "permission denied". Inputs are validated with the core schemas before any
 * write; the database trigger validates the timezone again.
 */
import {
  AvailableHoursSchema,
  HomeLayoutSchema,
  OwnerTimezoneSchema,
  applyHomeLayoutOperation,
  normalizeHomeLayout,
  ownerTimezoneCandidates,
  parseStoredAvailableHours,
  type AvailableHours,
  type HomeLayout,
  type HomeLayoutOperation,
} from '@personal-home/core'
import type postgres from 'postgres'
import type { Tx } from '../client.ts'

/** Validated plain data → the driver's JSON parameter type. */
const asJson = (value: unknown) => value as postgres.JSONValue

export interface OwnerSettings {
  timezone: string
  timezoneConfirmed: boolean
  displayName: string | null
  /** null = not set (the planner then suggests an order without a schedule). */
  availableHours: AvailableHours | null
  /** True when the stored value failed validation; it is shown as needing attention, not as empty. */
  availableHoursInvalid: boolean
  /** Always a complete, repaired layout (see normalizeHomeLayout). */
  homeLayout: HomeLayout
  notificationPrefs: Record<string, unknown>
  updatedAt: Date
}

interface OwnerSettingsRow {
  timezone: string
  timezoneConfirmed: boolean
  displayName: string | null
  availableHours: unknown
  homeLayout: unknown
  notificationPrefs: unknown
  updatedAt: Date
}

/** Raised when none of a timezone's spellings exist in the database's tz data. */
export class SettingsTimezoneNotRecognisedError extends Error {
  constructor(public readonly timezone: string) {
    super(`Timezone not recognised by the database: ${timezone}`)
    this.name = 'SettingsTimezoneNotRecognisedError'
  }
}

function toSettings(row: OwnerSettingsRow): OwnerSettings {
  const hours = parseStoredAvailableHours(row.availableHours)
  const prefs = row.notificationPrefs
  return {
    timezone: row.timezone,
    timezoneConfirmed: row.timezoneConfirmed,
    displayName: row.displayName,
    availableHours: hours.status === 'set' ? hours.hours : null,
    availableHoursInvalid: hours.status === 'invalid',
    homeLayout: normalizeHomeLayout(row.homeLayout),
    notificationPrefs:
      typeof prefs === 'object' && prefs !== null && !Array.isArray(prefs)
        ? (prefs as Record<string, unknown>)
        : {},
    updatedAt: row.updatedAt,
  }
}

/** The owner's settings, or null when the caller is not the owner (RLS hides the row). */
export async function getOwnerSettings(
  tx: Tx,
  options: { forUpdate?: boolean } = {},
): Promise<OwnerSettings | null> {
  const rows = options.forUpdate
    ? await tx<OwnerSettingsRow[]>`
        select timezone, timezone_confirmed, display_name, available_hours, home_layout,
               notification_prefs, updated_at
        from public.owner_settings where singleton
        for update
      `
    : await tx<OwnerSettingsRow[]>`
        select timezone, timezone_confirmed, display_name, available_hours, home_layout,
               notification_prefs, updated_at
        from public.owner_settings where singleton
      `
  const row = rows[0]
  return row ? toSettings(row) : null
}

/**
 * The spelling of `timezone` that this database accepts (IANA primary name
 * preferred), or null when none of its spellings exist in pg_timezone_names.
 */
export async function resolveTimezoneName(tx: Tx, timezone: string): Promise<string | null> {
  const candidates = ownerTimezoneCandidates(timezone)
  const rows = await tx<{ name: string }[]>`
    select name from pg_catalog.pg_timezone_names where name = any(${candidates}::text[])
  `
  const known = new Set(rows.map((r) => r.name))
  return candidates.find((c) => known.has(c)) ?? null
}

/** Zone names this database accepts (the timezone picker's source list). */
export async function listTimezoneNames(tx: Tx): Promise<string[]> {
  const rows = await tx<{ name: string }[]>`
    select name from pg_catalog.pg_timezone_names order by name
  `
  return rows.map((r) => r.name)
}

/**
 * Save the owner's timezone. `confirmed` records an explicit owner choice
 * (confirming the device default or picking one in Settings).
 * Returns null when the caller is not the owner.
 */
export async function updateTimezone(
  tx: Tx,
  timezone: string,
  confirmed: boolean,
): Promise<OwnerSettings | null> {
  const requested = OwnerTimezoneSchema.parse(timezone)
  const resolved = await resolveTimezoneName(tx, requested)
  if (!resolved) throw new SettingsTimezoneNotRecognisedError(requested)
  const rows = await tx<OwnerSettingsRow[]>`
    update public.owner_settings set timezone = ${resolved}, timezone_confirmed = ${confirmed}
    where singleton
    returning timezone, timezone_confirmed, display_name, available_hours, home_layout,
              notification_prefs, updated_at
  `
  const row = rows[0]
  return row ? toSettings(row) : null
}

/** Replace the home layout. The layout must be complete and valid (HomeLayoutSchema). */
export async function updateHomeLayout(tx: Tx, layout: HomeLayout): Promise<OwnerSettings | null> {
  const valid = HomeLayoutSchema.parse(layout)
  const rows = await tx<OwnerSettingsRow[]>`
    update public.owner_settings set home_layout = ${tx.json(asJson(valid))}
    where singleton
    returning timezone, timezone_confirmed, display_name, available_hours, home_layout,
              notification_prefs, updated_at
  `
  const row = rows[0]
  return row ? toSettings(row) : null
}

export type ChangeHomeLayoutResult =
  | { status: 'saved'; settings: OwnerSettings; changed: boolean }
  | { status: 'required_module' }
  | { status: 'not_owner' }

/**
 * Apply one reorder/hide/show/reset operation atomically: the row is locked,
 * so two quick taps in different tabs cannot overwrite each other.
 */
export async function changeHomeLayout(
  tx: Tx,
  operation: HomeLayoutOperation,
): Promise<ChangeHomeLayoutResult> {
  const current = await getOwnerSettings(tx, { forUpdate: true })
  if (!current) return { status: 'not_owner' }
  const result = applyHomeLayoutOperation(current.homeLayout, operation)
  if (!result.ok) return { status: 'required_module' }
  if (!result.changed) return { status: 'saved', settings: current, changed: false }
  const settings = await updateHomeLayout(tx, result.layout)
  if (!settings) return { status: 'not_owner' }
  return { status: 'saved', settings, changed: true }
}

/**
 * Replace available hours. An empty list clears them (stored as null = "not set").
 * Throws a ZodError for overlapping or malformed ranges.
 */
export async function updateAvailableHours(
  tx: Tx,
  hours: AvailableHours | null,
): Promise<OwnerSettings | null> {
  const valid = hours === null ? [] : AvailableHoursSchema.parse(hours)
  const rows = await tx<OwnerSettingsRow[]>`
    update public.owner_settings
    set available_hours = ${valid.length === 0 ? null : tx.json(asJson(valid))}
    where singleton
    returning timezone, timezone_confirmed, display_name, available_hours, home_layout,
              notification_prefs, updated_at
  `
  const row = rows[0]
  return row ? toSettings(row) : null
}
