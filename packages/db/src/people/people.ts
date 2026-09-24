/**
 * People repository: public.people and public.person_dates.
 *
 * Manual only — no contact import, no scraping, no relationship scoring. Every
 * function takes an owner transaction (withOwner) so Row Level Security applies.
 * `today` is the owner-local date ('YYYY-MM-DD'), supplied by the caller.
 */
import {
  CalendarDateSchema,
  catchUpStartedOnAfterEdit,
  catchUpStatus,
  nextImportantDateOccurrence,
  PeopleSearchSchema,
  PersonDateInputSchema,
  PersonInputSchema,
  type CatchUpStatus,
  type ImportantDateOccurrence,
  type PersonDateInput,
  type PersonInput,
} from '@personal-home/core'
import type { Tx } from '../client.ts'

export interface Person {
  id: string
  name: string
  relationship: string | null
  notes: string | null
  catchUpEveryDays: number | null
  lastCaughtUpOn: string | null
  catchUpStartedOn: string | null
  createdAt: Date
  updatedAt: Date
}

export interface PersonDate {
  id: string
  personId: string
  label: string
  month: number
  day: number
  year: number | null
  remindDaysBefore: number
  createdAt: Date
  updatedAt: Date
}

export interface PersonDateWithNext extends PersonDate {
  next: ImportantDateOccurrence
}

export interface PersonSummary extends Person {
  /** Soonest first. */
  dates: PersonDateWithNext[]
  catchUp: CatchUpStatus
}

/** Expected failures come back as values; unexpected ones (database errors) throw. */
export type PeopleResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid'; field: string; message: string }

const personColumns = (tx: Tx) =>
  tx`id, name, relationship, notes, catch_up_every_days, last_caught_up_on, catch_up_started_on,
     created_at, updated_at`

const dateColumns = (tx: Tx) =>
  tx`id, person_id, label, month::int as month, day::int as day, year::int as year,
     remind_days_before, created_at, updated_at`

function requireToday(today: string): string {
  return CalendarDateSchema.parse(today)
}

function futureCatchUp(lastCaughtUpOn: string | null, today: string): PeopleResult<never> | null {
  if (lastCaughtUpOn && lastCaughtUpOn > today) {
    return {
      ok: false,
      reason: 'invalid',
      field: 'lastCaughtUpOn',
      message: 'The last catch-up cannot be in the future',
    }
  }
  return null
}

function withNext(dates: readonly PersonDate[], today: string): PersonDateWithNext[] {
  return dates
    .map((d) => ({ ...d, next: nextImportantDateOccurrence(d, today) }))
    .sort((a, b) => a.next.daysUntil - b.next.daysUntil || a.label.localeCompare(b.label))
}

function summarise(person: Person, dates: readonly PersonDate[], today: string): PersonSummary {
  return { ...person, dates: withNext(dates, today), catchUp: catchUpStatus(person, today) }
}

export async function createPerson(
  tx: Tx,
  input: PersonInput,
  today: string,
): Promise<PeopleResult<Person>> {
  const day = requireToday(today)
  const f = PersonInputSchema.parse(input)
  const problem = futureCatchUp(f.lastCaughtUpOn, day)
  if (problem) return problem
  const startedOn = catchUpStartedOnAfterEdit(null, f.catchUpEveryDays, day)
  const [row] = await tx<Person[]>`
    insert into public.people (name, relationship, notes, catch_up_every_days, last_caught_up_on, catch_up_started_on)
    values (${f.name}, ${f.relationship}, ${f.notes}, ${f.catchUpEveryDays}, ${f.lastCaughtUpOn}, ${startedOn})
    returning ${personColumns(tx)}
  `
  if (!row) throw new Error('insert into people returned no row')
  return { ok: true, value: row }
}

export async function updatePerson(
  tx: Tx,
  id: string,
  input: PersonInput,
  today: string,
): Promise<PeopleResult<Person>> {
  const day = requireToday(today)
  const f = PersonInputSchema.parse(input)
  const problem = futureCatchUp(f.lastCaughtUpOn, day)
  if (problem) return problem
  const [previous] = await tx<Person[]>`
    select ${personColumns(tx)} from public.people where id = ${id}::uuid for update
  `
  if (!previous) return { ok: false, reason: 'not_found' }
  const startedOn = catchUpStartedOnAfterEdit(previous, f.catchUpEveryDays, day)
  const [row] = await tx<Person[]>`
    update public.people
    set name = ${f.name}, relationship = ${f.relationship}, notes = ${f.notes},
        catch_up_every_days = ${f.catchUpEveryDays}, last_caught_up_on = ${f.lastCaughtUpOn},
        catch_up_started_on = ${startedOn}
    where id = ${id}::uuid
    returning ${personColumns(tx)}
  `
  return row ? { ok: true, value: row } : { ok: false, reason: 'not_found' }
}

export async function deletePerson(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx`delete from public.people where id = ${id}::uuid returning id`
  return rows.length > 0
}

/**
 * Record a catch-up today. Idempotent, and never moves the date backwards (a later
 * date can already be stored if the owner's timezone changed westwards).
 */
export async function markCaughtUp(tx: Tx, id: string, today: string): Promise<Person | null> {
  const day = requireToday(today)
  const [row] = await tx<Person[]>`
    update public.people
    set last_caught_up_on = greatest(coalesce(last_caught_up_on, ${day}::date), ${day}::date)
    where id = ${id}::uuid
    returning ${personColumns(tx)}
  `
  return row ?? null
}

export async function getPerson(tx: Tx, id: string, today: string): Promise<PersonSummary | null> {
  const day = requireToday(today)
  const [person] = await tx<Person[]>`
    select ${personColumns(tx)} from public.people where id = ${id}::uuid
  `
  if (!person) return null
  const dates = await tx<PersonDate[]>`
    select ${dateColumns(tx)} from public.person_dates where person_id = ${id}::uuid
  `
  return summarise(person, dates, day)
}

/**
 * Everyone, alphabetically, with their dates and catch-up status. `search` matches
 * (case-insensitively, as plain text) the name, relationship label or notes.
 */
export async function listPeople(
  tx: Tx,
  options: { today: string; search?: string | null },
): Promise<PersonSummary[]> {
  const day = requireToday(options.today)
  const q = PeopleSearchSchema.parse(options.search)
  const people = await tx<Person[]>`
    select ${personColumns(tx)} from public.people
    where ${
      q === ''
        ? tx`true`
        : tx`strpos(lower(name), lower(${q})) > 0
             or strpos(lower(coalesce(relationship, '')), lower(${q})) > 0
             or strpos(lower(coalesce(notes, '')), lower(${q})) > 0`
    }
    order by lower(name), id
  `
  if (people.length === 0) return []
  const dates = await tx<PersonDate[]>`
    select ${dateColumns(tx)} from public.person_dates
    where person_id = any(${people.map((p) => p.id)}::uuid[])
  `
  const byPerson = new Map<string, PersonDate[]>()
  for (const d of dates) {
    const list = byPerson.get(d.personId)
    if (list) list.push(d)
    else byPerson.set(d.personId, [d])
  }
  return people.map((p) => summarise(p, byPerson.get(p.id) ?? [], day))
}

export async function addPersonDate(
  tx: Tx,
  personId: string,
  input: PersonDateInput,
): Promise<PeopleResult<PersonDate>> {
  const f = PersonDateInputSchema.parse(input)
  const person = await tx`select 1 from public.people where id = ${personId}::uuid`
  if (person.length === 0) return { ok: false, reason: 'not_found' }
  const [row] = await tx<PersonDate[]>`
    insert into public.person_dates (person_id, label, month, day, year, remind_days_before)
    values (${personId}::uuid, ${f.label}, ${f.month}, ${f.day}, ${f.year}, ${f.remindDaysBefore})
    returning ${dateColumns(tx)}
  `
  if (!row) throw new Error('insert into person_dates returned no row')
  return { ok: true, value: row }
}

export async function updatePersonDate(
  tx: Tx,
  dateId: string,
  input: PersonDateInput,
): Promise<PeopleResult<PersonDate>> {
  const f = PersonDateInputSchema.parse(input)
  const [row] = await tx<PersonDate[]>`
    update public.person_dates
    set label = ${f.label}, month = ${f.month}, day = ${f.day}, year = ${f.year},
        remind_days_before = ${f.remindDaysBefore}
    where id = ${dateId}::uuid
    returning ${dateColumns(tx)}
  `
  return row ? { ok: true, value: row } : { ok: false, reason: 'not_found' }
}

/** Delete one date. Returns the person it belonged to, or null when there was no such date. */
export async function deletePersonDate(
  tx: Tx,
  dateId: string,
): Promise<{ personId: string } | null> {
  const [row] = await tx<{ personId: string }[]>`
    delete from public.person_dates where id = ${dateId}::uuid returning person_id
  `
  return row ?? null
}
