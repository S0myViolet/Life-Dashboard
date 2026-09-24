/**
 * What People needs from Home: important dates coming up and catch-ups that are due.
 * Read-only, owner transaction (RLS applies). Deterministic: no scoring, no ranking
 * beyond "soonest first" and "most overdue first".
 */
import {
  CalendarDateSchema,
  catchUpStatus,
  nextImportantDateOccurrence,
  type CatchUpStatus,
} from '@personal-home/core'
import { z } from 'zod'
import type { Tx } from '../client.ts'

export interface PeopleAttentionDate {
  personId: string
  personName: string
  dateId: string
  label: string
  month: number
  day: number
  year: number | null
  /** The local date it is observed on (28 Feb for 29 Feb in a common year). */
  date: string
  daysUntil: number
  observedFromFeb29: boolean
  /** Years since the original date (the age being turned), when the year is known. */
  years: number | null
  remindDaysBefore: number
  /** Inside the owner's reminder window for this date (daysUntil ≤ remindDaysBefore). */
  reminderDue: boolean
}

export interface PeopleAttentionCatchUp {
  personId: string
  personName: string
  relationship: string | null
  catchUpEveryDays: number
  lastCaughtUpOn: string | null
  dueOn: string
  /** 0 = due today, 3 = three days overdue. */
  daysOverdue: number
  neverCaughtUp: boolean
}

export interface PeopleAttention {
  today: string
  horizonDays: number
  /** Dates from today to today + horizonDays (inclusive), soonest first. */
  upcomingDates: PeopleAttentionDate[]
  /** People whose catch-up is due today or overdue, most overdue first. */
  dueCatchUps: PeopleAttentionCatchUp[]
}

const HorizonSchema = z.number().int().min(0).max(366)

/**
 * Upcoming important dates within `horizonDays` of `today` and catch-ups that are due.
 * `today` is the owner-local date ('YYYY-MM-DD', from the owner's saved timezone).
 * Home should emphasise dates with `reminderDue` — the owner's own reminder window —
 * and can show the rest as "coming up".
 */
export async function listPeopleAttention(
  tx: Tx,
  today: string,
  horizonDays: number,
): Promise<PeopleAttention> {
  const day = CalendarDateSchema.parse(today)
  const horizon = HorizonSchema.parse(horizonDays)

  const dates = await tx<
    {
      personId: string
      personName: string
      dateId: string
      label: string
      month: number
      day: number
      year: number | null
      remindDaysBefore: number
    }[]
  >`
    select p.id as person_id, p.name as person_name, d.id as date_id, d.label,
           d.month::int as month, d.day::int as day, d.year::int as year, d.remind_days_before
    from public.person_dates d
    join public.people p on p.id = d.person_id
  `
  const upcomingDates: PeopleAttentionDate[] = []
  for (const d of dates) {
    const next = nextImportantDateOccurrence(d, day)
    if (next.daysUntil > horizon) continue
    upcomingDates.push({
      ...d,
      date: next.date,
      daysUntil: next.daysUntil,
      observedFromFeb29: next.observedFromFeb29,
      years: next.years,
      reminderDue: next.daysUntil <= d.remindDaysBefore,
    })
  }
  upcomingDates.sort(
    (a, b) =>
      a.daysUntil - b.daysUntil ||
      a.personName.localeCompare(b.personName) ||
      a.label.localeCompare(b.label),
  )

  const people = await tx<
    {
      id: string
      name: string
      relationship: string | null
      catchUpEveryDays: number
      lastCaughtUpOn: string | null
      catchUpStartedOn: string | null
    }[]
  >`
    select id, name, relationship, catch_up_every_days, last_caught_up_on, catch_up_started_on
    from public.people
    where catch_up_every_days is not null
  `
  const dueCatchUps: PeopleAttentionCatchUp[] = []
  for (const p of people) {
    const status: CatchUpStatus = catchUpStatus(p, day)
    if (status.state !== 'due' && status.state !== 'overdue') continue
    dueCatchUps.push({
      personId: p.id,
      personName: p.name,
      relationship: p.relationship,
      catchUpEveryDays: p.catchUpEveryDays,
      lastCaughtUpOn: p.lastCaughtUpOn,
      dueOn: status.dueOn ?? day,
      // `0 -` rather than unary minus: never a -0 for "due today".
      daysOverdue: 0 - (status.daysUntilDue ?? 0),
      neverCaughtUp: status.neverCaughtUp,
    })
  }
  dueCatchUps.sort(
    (a, b) => b.daysOverdue - a.daysOverdue || a.personName.localeCompare(b.personName),
  )

  return { today: day, horizonDays: horizon, upcomingDates, dueCatchUps }
}
