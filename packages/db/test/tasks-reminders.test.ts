/**
 * Reminders repository against a real database: owner-created reminders, task
 * reminders from the task form, due reminders, dismissal (recurring ones move
 * to their next occurrence) and RLS.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { localDateInZone, localTimeInZone } from '@personal-home/core'
import {
  completeTask,
  createReminder,
  createTask,
  deleteReminder,
  dismissReminder,
  getReminder,
  listDueReminders,
  listReminders,
  listTaskReminders,
  reopenTask,
  updateReminder,
  updateTask,
  withOwner,
  type OwnerClaims,
  type Tx,
} from '../src/index.ts'
import {
  createAuthUser,
  createTestDatabase,
  seedOwner,
  withAnon,
  type TestDatabase,
} from './harness.ts'

const LONDON = 'Europe/London'
const at = (s: string) => new Date(s)
const NOW = at('2026-09-24T12:00:00Z') // 13:00 BST
const ctx = { tz: LONDON, now: NOW }
const local = (d: Date) => `${localDateInZone(d, LONDON)} ${localTimeInZone(d, LONDON)}`

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
})

const asOwner = <T>(fn: (tx: Tx) => Promise<T>) => withOwner(t.db, owner, fn)
const asStranger = <T>(fn: (tx: Tx) => Promise<T>) => withOwner(t.db, stranger, fn)

describe('custom reminders', () => {
  it('creates one-off and recurring reminders in the owner timezone', async () => {
    const one = await asOwner((tx) =>
      createReminder(tx, { title: 'Bins out', date: '2026-09-24', time: '19:00' }, ctx),
    )
    expect(one.ok && one.reminder).toMatchObject({
      title: 'Bins out',
      subjectKind: 'custom',
      subjectId: null,
      remindAt: at('2026-09-24T18:00:00Z'),
      recurrence: null,
      recurrenceTime: null,
      recurrenceDay: null,
      status: 'scheduled',
    })
    const monthly = await asOwner((tx) =>
      createReminder(
        tx,
        { title: 'Pay rent', date: '2026-10-31', time: '09:00', recurrence: 'monthly' },
        ctx,
      ),
    )
    expect(monthly.ok && monthly.reminder).toMatchObject({
      recurrence: 'monthly',
      recurrenceTime: '09:00',
      recurrenceDay: 31,
      remindAt: at('2026-10-31T09:00:00Z'), // GMT by then
    })
  })

  it('refuses a past one-off time and invalid input', async () => {
    expect(
      await asOwner((tx) =>
        createReminder(tx, { title: 'Late', date: '2026-09-24', time: '12:59' }, ctx),
      ),
    ).toMatchObject({ ok: false, field: 'time' })
    expect(
      await asOwner((tx) =>
        createReminder(tx, { title: '', date: '2026-09-24', time: '19:00' }, ctx),
      ),
    ).toMatchObject({ ok: false, field: 'title' })
    expect(await asOwner((tx) => listReminders(tx))).toEqual([])
  })

  it('lists active reminders soonest first and due ones separately', async () => {
    for (const [title, time] of [
      ['b', '20:00'],
      ['a', '18:00'],
    ] as const) {
      await asOwner((tx) => createReminder(tx, { title, date: '2026-09-24', time }, ctx))
    }
    expect((await asOwner((tx) => listReminders(tx))).map((r) => r.title)).toEqual(['a', 'b'])
    expect(await asOwner((tx) => listDueReminders(tx, NOW))).toEqual([])
    const later = at('2026-09-24T18:30:00Z')
    expect((await asOwner((tx) => listDueReminders(tx, later))).map((r) => r.title)).toEqual(['a'])
  })

  it('dismissing a one-off closes it once', async () => {
    const r = await asOwner((tx) =>
      createReminder(tx, { title: 'Once', date: '2026-09-24', time: '14:00' }, ctx),
    )
    if (!r.ok) throw new Error('create failed')
    const later = { tz: LONDON, now: at('2026-09-24T14:00:00Z') }
    const d1 = await asOwner((tx) => dismissReminder(tx, r.reminder.id, later))
    expect(d1).toMatchObject({ ok: true, changed: true, advancedTo: null })
    expect(d1.ok && d1.reminder).toMatchObject({ status: 'dismissed', dismissedAt: later.now })
    const d2 = await asOwner((tx) => dismissReminder(tx, r.reminder.id, later))
    expect(d2).toMatchObject({ ok: true, changed: false })
    expect(await asOwner((tx) => listDueReminders(tx, later.now))).toEqual([])
  })

  it('dismissing a recurring reminder moves it to the next occurrence, keeping local time over DST', async () => {
    const r = await asOwner((tx) =>
      createReminder(
        tx,
        { title: 'Stand-up', date: '2026-10-23', time: '09:00', recurrence: 'daily' },
        ctx,
      ),
    )
    if (!r.ok) throw new Error('create failed')
    // Not dismissed for two days, across the 25 October change back to GMT.
    const late = { tz: LONDON, now: at('2026-10-25T12:00:00Z') }
    const d = await asOwner((tx) => dismissReminder(tx, r.reminder.id, late))
    expect(d.ok && d.advancedTo && local(d.advancedTo)).toBe('2026-10-26 09:00')
    expect(d.ok && d.reminder).toMatchObject({
      status: 'scheduled',
      remindAt: at('2026-10-26T09:00:00Z'),
      recurrenceTime: '09:00',
    })
  })

  it('updating reschedules and reopens; delete removes', async () => {
    const r = await asOwner((tx) =>
      createReminder(tx, { title: 'x', date: '2026-09-24', time: '14:00' }, ctx),
    )
    if (!r.ok) throw new Error('create failed')
    const later = { tz: LONDON, now: at('2026-09-24T14:00:00Z') }
    await asOwner((tx) => dismissReminder(tx, r.reminder.id, later))
    const u = await asOwner((tx) =>
      updateReminder(
        tx,
        r.reminder.id,
        { title: 'y', date: '2026-09-30', time: '08:00', recurrence: 'weekly' },
        later,
      ),
    )
    expect(u.ok && u.reminder).toMatchObject({
      title: 'y',
      status: 'scheduled',
      dismissedAt: null,
      recurrence: 'weekly',
      recurrenceTime: '08:00',
      recurrenceDay: null,
      remindAt: at('2026-09-30T07:00:00Z'),
    })
    expect(await asOwner((tx) => deleteReminder(tx, r.reminder.id))).toBe(true)
    expect(await asOwner((tx) => getReminder(tx, r.reminder.id))).toBeNull()
  })

  it('the database keeps anchors only on recurring reminders', async () => {
    await expect(
      asOwner(
        (tx) =>
          tx`insert into public.reminders (title, remind_at, recurrence_time) values ('x', now(), '09:00')`,
      ),
    ).rejects.toThrow(/reminders_anchors_need_recurrence/)
    await expect(
      asOwner(
        (tx) =>
          tx`insert into public.reminders (title, remind_at, recurrence, recurrence_time) values ('x', now(), 'daily', '9am')`,
      ),
    ).rejects.toThrow(/check constraint/)
  })
})

describe('task reminders', () => {
  it('are set, kept, replaced and cleared from the task form', async () => {
    const created = await asOwner((tx) =>
      createTask(
        tx,
        { title: 'Dentist', dueDate: '2026-09-25', dueTime: '14:30' },
        { ...ctx, reminder: { choice: '1h' } },
      ),
    )
    if (!created.ok) throw new Error(JSON.stringify(created))
    const task = created.task
    expect(created.reminder).toMatchObject({
      title: 'Dentist',
      subjectKind: 'task',
      subjectId: task.id,
      remindAt: at('2026-09-25T12:30:00Z'),
    })
    // Keep leaves it alone even when the due time moves.
    const kept = await asOwner((tx) =>
      updateTask(
        tx,
        task.id,
        { dueDate: '2026-09-25', dueTime: '16:00' },
        { ...ctx, reminder: { choice: 'keep' } },
      ),
    )
    expect(kept.ok && kept.reminder?.remindAt).toEqual(at('2026-09-25T12:30:00Z'))
    // A new choice replaces the active reminder (still only one).
    await asOwner((tx) =>
      updateTask(
        tx,
        task.id,
        {},
        { ...ctx, reminder: { choice: 'custom', date: '2026-09-25', time: '08:00' } },
      ),
    )
    const map = await asOwner((tx) => listTaskReminders(tx, [task.id]))
    expect(map.get(task.id)?.map((r) => r.remindAt)).toEqual([at('2026-09-25T07:00:00Z')])
    const cleared = await asOwner((tx) =>
      updateTask(tx, task.id, {}, { ...ctx, reminder: { choice: 'none' } }),
    )
    expect(cleared.ok && cleared.reminder).toBeNull()
    expect((await asOwner((tx) => listTaskReminders(tx, [task.id]))).size).toBe(0)
  })

  it('are hidden while the task is closed and come back when it is reopened', async () => {
    const created = await asOwner((tx) =>
      createTask(
        tx,
        { title: 'Call', dueDate: '2026-09-24', dueTime: '18:00' },
        { ...ctx, reminder: { choice: 'at_due' } },
      ),
    )
    if (!created.ok) throw new Error('create failed')
    const due = at('2026-09-24T17:30:00Z')
    expect((await asOwner((tx) => listDueReminders(tx, due))).map((r) => r.taskTitle)).toEqual([
      'Call',
    ])
    await asOwner((tx) => completeTask(tx, created.task.id, NOW))
    expect(await asOwner((tx) => listDueReminders(tx, due))).toEqual([])
    expect(await asOwner((tx) => listReminders(tx))).toEqual([])
    await asOwner((tx) => reopenTask(tx, created.task.id, NOW))
    expect(await asOwner((tx) => listDueReminders(tx, due))).toHaveLength(1)
  })

  it('cannot be attached to a closed or missing task', async () => {
    const created = await asOwner((tx) => createTask(tx, { title: 'Closed' }, ctx))
    if (!created.ok) throw new Error('create failed')
    await asOwner((tx) => completeTask(tx, created.task.id, NOW))
    const input = { title: 'x', date: '2026-09-25', time: '09:00' }
    expect(
      await asOwner((tx) =>
        createReminder(tx, input, { ...ctx, subject: { kind: 'task', id: created.task.id } }),
      ),
    ).toMatchObject({ ok: false, field: 'subject' })
    expect(
      await asOwner((tx) =>
        createReminder(tx, input, {
          ...ctx,
          subject: { kind: 'task', id: '5f0c7c7e-6c1c-4d0e-9d7a-0f6f4c1d2e3a' },
        }),
      ),
    ).toMatchObject({ ok: false, field: 'subject' })
  })
})

describe('reminders row level security', () => {
  it('a stranger and anon see and change nothing', async () => {
    const r = await asOwner((tx) =>
      createReminder(
        tx,
        { title: 'Mine', date: '2026-09-24', time: '12:30' },
        {
          tz: LONDON,
          now: at('2026-09-24T11:00:00Z'),
        },
      ),
    )
    if (!r.ok) throw new Error('create failed')
    expect(await asStranger((tx) => listReminders(tx, { includeClosed: true }))).toEqual([])
    expect(await asStranger((tx) => listDueReminders(tx, NOW))).toEqual([])
    expect(await asStranger((tx) => dismissReminder(tx, r.reminder.id, ctx))).toEqual({
      ok: false,
      reason: 'not_found',
    })
    expect(await asStranger((tx) => deleteReminder(tx, r.reminder.id))).toBe(false)
    await expect(
      asStranger((tx) =>
        createReminder(tx, { title: 'x', date: '2026-09-25', time: '09:00' }, ctx),
      ),
    ).rejects.toThrow(/row-level security/)
    await expect(withAnon(t.db, (tx) => tx`select * from public.reminders`)).rejects.toThrow(
      /permission denied/,
    )
    expect(await asOwner((tx) => listDueReminders(tx, NOW))).toHaveLength(1)
  })
})
