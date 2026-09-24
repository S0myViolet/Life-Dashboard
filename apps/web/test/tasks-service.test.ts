/**
 * Tasks/habits/reminders server-action bodies (lib/tasks/service.ts) against a
 * real database: untrusted FormData in, validated owner-scoped writes out.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { withOwner, type OwnerClaims, type Tx } from '@personal-home/db'
import {
  createAuthUser,
  createTestDatabase,
  seedOwner,
  type TestDatabase,
} from '@personal-home/db/testing'
import {
  archiveHabitById,
  changeTaskStatus,
  createHabitFromForm,
  createReminderFromForm,
  createTaskFromForm,
  dismissReminderById,
  removeTask,
  toggleHabitDay,
  updateHabitFromForm,
  updateTaskFromForm,
} from '@/lib/tasks/service'
import { loadHabits, loadReminders, loadTaskBoard } from '@/lib/tasks/view'

declare module 'vitest' {
  export interface ProvidedContext {
    templateDb: string
  }
}

const NOW = new Date('2026-09-24T12:00:00Z') // Thursday 13:00 BST

let t: TestDatabase
let owner: OwnerClaims
let stranger: OwnerClaims

beforeAll(async () => {
  t = await createTestDatabase()
  owner = await seedOwner(t.db)
  stranger = await createAuthUser(t.db, 'stranger@example.com')
})
afterAll(async () => {
  await t?.drop()
})
beforeEach(async () => {
  await t.db`delete from public.reminders`
  await t.db`delete from public.tasks`
  await t.db`delete from public.habits`
  await t.db`update public.owner_settings set timezone = 'Europe/London'`
})

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) data.append(name, v)
  }
  return data
}

const asOwner = <T>(fn: (tx: Tx) => Promise<T>) => withOwner(t.db, owner, fn)
const asStranger = <T>(fn: (tx: Tx) => Promise<T>) => withOwner(t.db, stranger, fn)

describe('createTaskFromForm', () => {
  it('creates a task with a London due time and a relative reminder', async () => {
    const state = await asOwner((tx) =>
      createTaskFromForm(
        tx,
        form({
          title: 'Dentist',
          dueDate: '2026-09-25',
          dueTime: '14:30',
          priority: '1',
          durationMinutes: '45',
          splittable: 'on',
          reminder: '1h',
          details: '  Bring the form  ',
        }),
        NOW,
      ),
    )
    expect(state).toMatchObject({
      status: 'saved',
      message: 'Added “Dentist”.',
      notice: 'Reminder set for Tomorrow · 13:30.',
    })
    const [row] = await t.db<{ local: string; details: string; splittable: boolean }[]>`
      select to_char(due_at at time zone 'Europe/London', 'YYYY-MM-DD HH24:MI') as local,
             details, splittable
      from public.tasks
    `
    expect(row).toEqual({ local: '2026-09-25 14:30', details: 'Bring the form', splittable: true })
  })

  it('reports every field problem at once and echoes the values', async () => {
    const state = await asOwner((tx) =>
      createTaskFromForm(
        tx,
        form({ title: '  ', dueDate: '2026-09-25', durationMinutes: '3', reminder: 'none' }),
        NOW,
      ),
    )
    expect(state).toMatchObject({
      status: 'error',
      fieldErrors: {
        title: 'Give the task a title',
        durationMinutes: 'Duration must be 5–720 minutes',
      },
      values: { title: '  ', dueDate: '2026-09-25', durationMinutes: '3', reminder: 'none' },
    })
    expect((await t.db`select 1 from public.tasks`).length).toBe(0)
  })

  it('rejects tampered select values and an unknown reminder choice', async () => {
    const state = await asOwner((tx) =>
      createTaskFromForm(tx, form({ title: 'x', priority: '9', reminder: 'hourly' }), NOW),
    )
    expect(state).toMatchObject({
      status: 'error',
      fieldErrors: {
        priority: 'Choose a priority from the list',
        reminder: 'Choose a reminder from the list',
      },
    })
  })

  it('says when a time falls in the DST gap', async () => {
    const state = await asOwner((tx) =>
      createTaskFromForm(
        tx,
        form({ title: 'Clocks', dueDate: '2027-03-28', dueTime: '01:30' }),
        NOW,
      ),
    )
    expect(state.status === 'saved' && state.notice).toContain('saved as 02:30')
  })

  it('refuses a relative reminder without a due time, next to the reminder field', async () => {
    const state = await asOwner((tx) =>
      createTaskFromForm(tx, form({ title: 'x', dueDate: '2026-09-25', reminder: '15m' }), NOW),
    )
    expect(state).toMatchObject({ status: 'error', fieldErrors: { reminder: expect.any(String) } })
  })

  it('a stranger cannot create tasks (the transaction fails, nothing is written)', async () => {
    // Not the owner: settings are invisible, so the timezone cannot be read.
    await expect(
      asStranger((tx) => createTaskFromForm(tx, form({ title: 'x' }), NOW)),
    ).rejects.toThrow()
    expect((await t.db`select 1 from public.tasks`).length).toBe(0)
  })
})

describe('updateTaskFromForm and status changes', () => {
  async function seed(): Promise<string> {
    const state = await asOwner((tx) =>
      createTaskFromForm(
        tx,
        form({ title: 'Plan trip', dueDate: '2026-09-25', dueTime: '09:00', reminder: 'at_due' }),
        NOW,
      ),
    )
    expect(state.status).toBe('saved')
    const [row] = await t.db<{ id: string }[]>`select id from public.tasks`
    return row!.id
  }

  it('updates fields, keeps the reminder by default and the project when not posted', async () => {
    const id = await seed()
    await t.db`update public.tasks set project_id = '5f0c7c7e-6c1c-4d0e-9d7a-0f6f4c1d2e3a' where id = ${id}`
    const state = await asOwner((tx) =>
      updateTaskFromForm(
        tx,
        form({
          taskId: id,
          title: 'Plan the trip',
          dueDate: '2026-09-26',
          dueTime: '',
          priority: '',
        }),
        NOW,
      ),
    )
    expect(state).toMatchObject({ status: 'saved', message: 'Saved “Plan the trip”.' })
    const [row] = await t.db<
      { title: string; dueDate: string; dueAt: Date | null; projectId: string }[]
    >`select title, due_date, due_at, project_id from public.tasks`
    expect(row).toEqual({
      title: 'Plan the trip',
      dueDate: '2026-09-26',
      dueAt: null,
      projectId: '5f0c7c7e-6c1c-4d0e-9d7a-0f6f4c1d2e3a',
    })
    const [rem] = await t.db<{ title: string }[]>`select title from public.reminders`
    expect(rem?.title).toBe('Plan the trip')
  })

  it('refuses a missing or malformed id', async () => {
    for (const taskId of ['', 'nope', '5f0c7c7e-6c1c-4d0e-9d7a-0f6f4c1d2e3a']) {
      const state = await asOwner((tx) => updateTaskFromForm(tx, form({ taskId, title: 'x' }), NOW))
      expect(state.status, taskId).toBe('error')
    }
  })

  it('completes, reopens and deletes through validated ids only', async () => {
    const id = await seed()
    expect(await asOwner((tx) => changeTaskStatus(tx, id, 'complete', NOW))).toEqual({ ok: true })
    expect(await asOwner((tx) => changeTaskStatus(tx, id, 'cancel', NOW))).toMatchObject({
      ok: false,
    })
    expect(await asOwner((tx) => changeTaskStatus(tx, 'x', 'reopen', NOW))).toMatchObject({
      ok: false,
    })
    expect(await asOwner((tx) => changeTaskStatus(tx, id, 'reopen', NOW))).toEqual({ ok: true })
    expect(await asStranger((tx) => removeTask(tx, id))).toMatchObject({ ok: false })
    expect(await asOwner((tx) => removeTask(tx, id))).toEqual({
      ok: true,
      message: 'Task deleted.',
    })
    expect((await t.db`select 1 from public.reminders`).length).toBe(0)
  })
})

describe('reminders', () => {
  it('creates in London time, validates, and dismisses', async () => {
    const bad = await asOwner((tx) =>
      createReminderFromForm(tx, form({ title: '', date: '', time: '' }), NOW),
    )
    expect(bad).toMatchObject({
      status: 'error',
      fieldErrors: { date: 'Pick a date', time: 'Pick a time' },
    })
    const ok = await asOwner((tx) =>
      createReminderFromForm(
        tx,
        form({ title: 'Stand-up', date: '2026-09-24', time: '09:00', recurrence: 'daily' }),
        NOW,
      ),
    )
    // 09:00 today has passed, so a daily reminder starts tomorrow.
    expect(ok).toMatchObject({ status: 'saved', message: 'Reminder set for Tomorrow · 09:00.' })
    const [row] = await t.db<{ id: string }[]>`select id from public.reminders`
    const later = new Date('2026-09-25T08:30:00Z')
    expect(await asOwner((tx) => dismissReminderById(tx, row!.id, later))).toEqual({
      ok: true,
      message: 'Next reminder: Tomorrow · 09:00.',
    })
    expect(await asOwner((tx) => dismissReminderById(tx, 'nope', later))).toMatchObject({
      ok: false,
    })
  })
})

describe('habits', () => {
  it('creates, validates weekdays, toggles today and archives', async () => {
    expect(await asOwner((tx) => createHabitFromForm(tx, form({ title: 'Walk' })))).toMatchObject({
      status: 'error',
      fieldErrors: { weekdays: 'Pick at least one day' },
    })
    expect(
      await asOwner((tx) => createHabitFromForm(tx, form({ title: 'Walk', weekdays: ['8'] }))),
    ).toMatchObject({ status: 'error', fieldErrors: { weekdays: 'Pick days from the list' } })
    const created = await asOwner((tx) =>
      createHabitFromForm(tx, form({ title: 'Walk', weekdays: ['1', '4', '4'] })),
    )
    expect(created).toMatchObject({ status: 'saved', message: 'Added “Walk”.' })
    const [habit] = await t.db<
      { id: string; weekdays: number[] }[]
    >`select id, weekdays from public.habits`
    expect(habit?.weekdays).toEqual([1, 4])

    const updated = await asOwner((tx) =>
      updateHabitFromForm(
        tx,
        form({ habitId: habit!.id, title: 'Walk far', weekdays: ['4'], details: '' }),
      ),
    )
    expect(updated).toMatchObject({ status: 'saved' })

    expect(
      await asOwner((tx) =>
        toggleHabitDay(tx, { habitId: habit!.id, localDate: '2026-09-24', done: true }, NOW),
      ),
    ).toEqual({ ok: true })
    expect(
      await asOwner((tx) =>
        toggleHabitDay(tx, { habitId: habit!.id, localDate: '2026-09-25', done: true }, NOW),
      ),
    ).toMatchObject({ ok: false })
    expect(
      await asOwner((tx) =>
        toggleHabitDay(tx, { habitId: habit!.id, localDate: '2026-09-24', done: 'yes' }, NOW),
      ),
    ).toMatchObject({ ok: false })

    const view = await asOwner((tx) => loadHabits(tx, NOW))
    expect(view.habits[0]).toMatchObject({ title: 'Walk far', doneToday: true, dueToday: true })
    expect(view.todayLabel).toBe('Thursday 24 September')

    expect(await asOwner((tx) => archiveHabitById(tx, habit!.id, true, NOW))).toEqual({
      ok: true,
      message: 'Habit archived.',
    })
    const after = await asOwner((tx) => loadHabits(tx, NOW))
    expect(after.habits).toEqual([])
    expect(after.archived.map((h) => h.title)).toEqual(['Walk far'])
  })
})

describe('page data', () => {
  it('groups tasks and formats every label in the owner timezone', async () => {
    await t.db`update public.owner_settings set timezone = 'America/New_York'`
    await t.db`
      insert into public.tasks (title, due_date, due_at) values
        ('Timed', '2026-09-24', '2026-09-24T20:00:00Z'),
        ('Overdue', '2026-09-20', null)
    `
    const board = await asOwner((tx) => loadTaskBoard(tx, NOW))
    expect(board.tz).toBe('America/New_York')
    expect(board.today).toBe('2026-09-24')
    const timed = board.tasks.find((x) => x.title === 'Timed')!
    expect(timed).toMatchObject({ group: 'today', dueLabel: 'Today · 16:00', dueTime: '16:00' })
    expect(board.tasks.find((x) => x.title === 'Overdue')).toMatchObject({
      group: 'overdue',
      dueLabel: 'Sun 20 Sep',
    })
    const reminders = await asOwner((tx) => loadReminders(tx, NOW))
    expect(reminders).toMatchObject({ tz: 'America/New_York', due: [], upcoming: [] })
  })
})
