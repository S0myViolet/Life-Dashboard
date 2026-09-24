/**
 * Recurring schedules (private.job_schedules) and the owner context the
 * scheduler needs. Service transactions only.
 */
import type { JobKind, JobScheduleCadence, JobScheduleDefinition } from '@personal-home/core'
import type postgres from 'postgres'
import type { Tx } from '../client.ts'

export interface JobScheduleRow {
  name: string
  kind: JobKind
  cadence: JobScheduleCadence
  localTime: string | null
  intervalSeconds: number | null
  enabled: boolean
  enabledSince: Date | null
  nextRunAt: Date | null
  lastOccurrenceAt: Date | null
  lastEnqueuedAt: Date | null
  lastSuccessAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Copy schedule definitions (code) into private.job_schedules. Idempotent and
 * write-free when nothing changed. Enabling a schedule stamps `enabled_since`;
 * changing its timing clears `next_run_at`; schedules no longer defined are disabled.
 */
export async function syncJobSchedules(
  tx: Tx,
  definitions: readonly JobScheduleDefinition[],
  now: Date,
): Promise<void> {
  const names = definitions.map((d) => d.name)
  if (new Set(names).size !== names.length) throw new Error('duplicate job schedule names')
  const rows = definitions.map((d) => ({
    name: d.name,
    kind: d.kind,
    cadence: d.cadence,
    local_time: d.cadence === 'daily_local_time' ? d.localTime : null,
    interval_seconds: d.cadence === 'interval' ? d.intervalSeconds : null,
    enabled: d.enabled,
  }))
  // One statement for all definitions (the dispatcher runs this every minute).
  await tx`
    insert into private.job_schedules as s
      (name, kind, cadence, local_time, interval_seconds, enabled, enabled_since)
    select d.name, d.kind, d.cadence, d.local_time, d.interval_seconds, d.enabled,
           case when d.enabled then ${now}::timestamptz end
    from jsonb_to_recordset(${tx.json(rows as postgres.JSONValue)}::jsonb)
      as d(name text, kind text, cadence text, local_time text, interval_seconds integer, enabled boolean)
    on conflict (name) do update set
      kind = excluded.kind,
      cadence = excluded.cadence,
      local_time = excluded.local_time,
      interval_seconds = excluded.interval_seconds,
      enabled = excluded.enabled,
      enabled_since = case
        when not excluded.enabled then null
        when s.enabled then s.enabled_since
        else excluded.enabled_since
      end,
      next_run_at = case
        when s.cadence is distinct from excluded.cadence
          or s.local_time is distinct from excluded.local_time
          or s.interval_seconds is distinct from excluded.interval_seconds
          or not excluded.enabled
        then null
        else s.next_run_at
      end
    where s.kind is distinct from excluded.kind
       or s.cadence is distinct from excluded.cadence
       or s.local_time is distinct from excluded.local_time
       or s.interval_seconds is distinct from excluded.interval_seconds
       or s.enabled is distinct from excluded.enabled
  `
  await tx`
    update private.job_schedules
    set enabled = false, enabled_since = null, next_run_at = null
    where enabled and not (name = any (${names}::text[]))
  `
}

/**
 * Enabled schedules, row-locked for this transaction. Rows another dispatcher
 * is materialising right now are skipped (it will handle them).
 */
export async function lockEnabledJobSchedules(tx: Tx): Promise<JobScheduleRow[]> {
  const rows = await tx<JobScheduleRow[]>`
    select * from private.job_schedules where enabled order by name for update skip locked
  `
  return [...rows]
}

export async function listJobSchedules(tx: Tx): Promise<JobScheduleRow[]> {
  const rows = await tx<JobScheduleRow[]>`select * from private.job_schedules order by name`
  return [...rows]
}

export async function recordJobScheduleProgress(
  tx: Tx,
  name: string,
  p: { nextRunAt: Date; lastOccurrenceAt?: Date; lastEnqueuedAt?: Date },
): Promise<void> {
  await tx`
    update private.job_schedules set
      next_run_at = ${p.nextRunAt}::timestamptz,
      last_occurrence_at = coalesce(${p.lastOccurrenceAt ?? null}::timestamptz, last_occurrence_at),
      last_enqueued_at = coalesce(${p.lastEnqueuedAt ?? null}::timestamptz, last_enqueued_at)
    where name = ${name}
  `
}

export interface JobOwnerContext {
  /** A dashboard owner has been claimed. Briefings are pointless before that. */
  hasOwner: boolean
  /** owner_settings.timezone (validated IANA name), or null when the row is missing. */
  timezone: string | null
  timezoneConfirmed: boolean
}

/** Owner facts the scheduler and briefing handlers need (service read, bypasses RLS). */
export async function readJobOwnerContext(tx: Tx): Promise<JobOwnerContext> {
  const [row] = await tx<
    { hasOwner: boolean; timezone: string | null; timezoneConfirmed: boolean | null }[]
  >`
    select
      exists (select 1 from private.owner) as has_owner,
      (select s.timezone from public.owner_settings s limit 1) as timezone,
      (select s.timezone_confirmed from public.owner_settings s limit 1) as timezone_confirmed
  `
  return {
    hasOwner: row?.hasOwner === true,
    timezone: row?.timezone ?? null,
    timezoneConfirmed: row?.timezoneConfirmed === true,
  }
}
