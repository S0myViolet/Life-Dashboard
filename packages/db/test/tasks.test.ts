/**
 * Tasks repository against a real database: RLS, owner-timezone due dates,
 * list filters that agree with core classification, status transitions,
 * project options and the Needs attention query.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { classifyTaskDue, type TaskCreateInput } from '@personal-home/core'
import {
  completeTask,
  createTask,
  deleteTask,
  getTask,
  listNeedsAttention,
  listTaskProjectOptions,
  listTasks,
  reopenTask,
  setTaskStatus,
  cancelTask,
  tasksOwnerTimeZone,
  tasksProjectExists,
  updateTask,
  withOwner,
  type OwnerClaims,
  type TaskRow,
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
const NOW = at('2026-09-24T12:00:00Z') // Thursday 13:00 BST

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
const ctx = { tz: LONDON, now: NOW }

async function make(input: TaskCreateInput, now = NOW): Promise<TaskRow> {
  const r = await asOwner((tx) => createTask(tx, input, { tz: LONDON, now }))
  if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r)}`)
  return r.task
}

describe('row level security', () => {
  it('a stranger and anon can neither read nor write tasks', async () => {
    const task = await make({ title: 'Private' })
    expect(await asStranger((tx) => listTasks(tx))).toEqual([])
    expect(await asStranger((tx) => getTask(tx, task.id))).toBeNull()
    expect(await asStranger((tx) => completeTask(tx, task.id, NOW))).toEqual({
      ok: false,
      reason: 'not_found',
    })
    expect(await asStranger((tx) => deleteTask(tx, task.id))).toBe(false)
    await expect(asStranger((tx) => createTask(tx, { title: 'x' }, ctx))).rejects.toThrow(
      /row-level security/,
    )
    await expect(withAnon(t.db, (tx) => tx`select * from public.tasks`)).rejects.toThrow(
      /permission denied/,
    )
    await expect(withAnon(t.db, (tx) => listNeedsAttention(tx, NOW, LONDON))).rejects.toThrow(
      /permission denied/,
    )
    expect((await asOwner((tx) => getTask(tx, task.id)))?.title).toBe('Private')
    expect(await asStranger((tx) => listNeedsAttention(tx, NOW, LONDON))).toMatchObject({
      items: [],
    })
  })

  it('reads the owner timezone only for the owner', async () => {
    expect(await asOwner((tx) => tasksOwnerTimeZone(tx))).toBe(LONDON)
    expect(await asStranger((tx) => tasksOwnerTimeZone(tx))).toBeNull()
  })
})

describe('createTask', () => {
  it('stores a due time in the owner timezone as an instant plus its local date', async () => {
    const r = await asOwner((tx) =>
      createTask(
        tx,
        {
          title: '  Renew passport ',
          priority: 1,
          dueDate: '2026-09-25',
          dueTime: '14:30',
          durationMinutes: 45,
          splittable: true,
        },
        ctx,
      ),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.task).toMatchObject({
      title: 'Renew passport',
      status: 'open',
      priority: 1,
      dueDate: '2026-09-25',
      dueAt: at('2026-09-25T13:30:00Z'),
      durationMinutes: 45,
      splittable: true,
      source: 'manual',
      confirmed: true,
      completedAt: null,
    })
    // Postgres agrees about the wall clock in London.
    const [row] = await t.db<{ local: string }[]>`
      select to_char(due_at at time zone 'Europe/London', 'YYYY-MM-DD HH24:MI') as local
      from public.tasks where id = ${r.task.id}
    `
    expect(row?.local).toBe('2026-09-25 14:30')
  })

  it('reports a DST-gap time that was moved forward', async () => {
    const r = await asOwner((tx) =>
      createTask(tx, { title: 'Clocks', dueDate: '2027-03-28', dueTime: '01:30' }, ctx),
    )
    expect(r.ok && r.due.shiftedTo).toBe('02:30')
    expect(r.ok && r.task.dueAt).toEqual(at('2027-03-28T01:30:00Z'))
  })

  it('returns field errors instead of writing invalid tasks', async () => {
    const cases: [TaskCreateInput, string][] = [
      [{ title: '   ' }, 'title'],
      [{ title: 'x', priority: 7 as 1 }, 'priority'],
      [{ title: 'x', durationMinutes: 3 }, 'durationMinutes'],
      [{ title: 'x', dueTime: '10:00' }, 'dueTime'],
      [{ title: 'x', dueDate: '2026-02-29' }, 'dueDate'],
      [{ title: 'x', projectId: '5f0c7c7e-6c1c-4d0e-9d7a-0f6f4c1d2e3a' }, 'projectId'],
      [{ title: 'x', dueDate: '2026-09-25' }, 'reminder'],
    ]
    for (const [input, field] of cases) {
      const reminder = field === 'reminder' ? ({ choice: '1h' } as const) : undefined
      const r = await asOwner((tx) => createTask(tx, input, { ...ctx, reminder }))
      expect(r, JSON.stringify(input)).toMatchObject({ ok: false, reason: 'invalid', field })
    }
    expect(await asOwner((tx) => listTasks(tx))).toEqual([])
  })

  it('the database rejects a due time without a due date or done without a time', async () => {
    await expect(
      asOwner((tx) => tx`insert into public.tasks (title, due_at) values ('x', now())`),
    ).rejects.toThrow(/tasks_due_at_has_date/)
    await expect(
      asOwner((tx) => tx`insert into public.tasks (title, status) values ('x', 'done')`),
    ).rejects.toThrow(/tasks_done_has_time/)
  })
})

describe('updateTask', () => {
  it('keeps omitted fields, clears nulls and replaces date and time together', async () => {
    const task = await make({
      title: 'Plan trip',
      priority: 2,
      dueDate: '2026-09-25',
      dueTime: '09:00',
      durationMinutes: 60,
      details: 'Look at trains',
    })
    const r = await asOwner((tx) =>
      updateTask(tx, task.id, { priority: null, dueDate: '2026-09-26' }, ctx),
    )
    expect(r.ok && r.task).toMatchObject({
      title: 'Plan trip',
      priority: null,
      dueDate: '2026-09-26',
      dueAt: null, // no time sent with the date: now date-only
      durationMinutes: 60,
      details: 'Look at trains',
    })
    const r2 = await asOwner((tx) =>
      updateTask(tx, task.id, { dueDate: '2026-12-01', dueTime: '08:15' }, ctx),
    )
    expect(r2.ok && r2.task.dueAt).toEqual(at('2026-12-01T08:15:00Z'))
    const cleared = await asOwner((tx) =>
      updateTask(tx, task.id, { dueDate: null, details: null }, ctx),
    )
    expect(cleared.ok && cleared.task).toMatchObject({ dueDate: null, dueAt: null, details: null })
  })

  it('renames the task reminders with the task', async () => {
    const task = await make({ title: 'Old', dueDate: '2026-09-25', dueTime: '10:00' })
    await asOwner((tx) => updateTask(tx, task.id, {}, { ...ctx, reminder: { choice: '1h' } }))
    await asOwner((tx) => updateTask(tx, task.id, { title: 'New' }, ctx))
    const [rem] = await t.db<{ title: string; remindAt: Date }[]>`
      select title, remind_at from public.reminders where subject_id = ${task.id}
    `
    expect(rem).toEqual({ title: 'New', remindAt: at('2026-09-25T08:00:00Z') })
  })

  it('is not found for a stranger or an unknown id', async () => {
    const task = await make({ title: 'Mine' })
    expect(await asStranger((tx) => updateTask(tx, task.id, { title: 'Theirs' }, ctx))).toEqual({
      ok: false,
      reason: 'not_found',
    })
    expect(await asOwner((tx) => updateTask(tx, 'not-a-uuid', { title: 'x' }, ctx))).toEqual({
      ok: false,
      reason: 'not_found',
    })
    expect((await asOwner((tx) => getTask(tx, task.id)))?.title).toBe('Mine')
  })
})

describe('listTasks filters', () => {
  async function seedVariety() {
    const specs: [string, TaskCreateInput['dueDate'], TaskCreateInput['dueTime']][] = [
      ['overdue-date', '2026-09-20', null],
      ['overdue-timed-today', '2026-09-24', '09:00'],
      ['today-untimed', '2026-09-24', null],
      ['today-later', '2026-09-24', '23:59'],
      ['tomorrow-midnight', '2026-09-25', '00:00'],
      ['upcoming-date', '2026-10-01', null],
      ['no-date', null, null],
    ]
    const created: TaskRow[] = []
    for (const [title, dueDate, dueTime] of specs) {
      // Created a week earlier so past times are allowed.
      created.push(await make({ title, dueDate, dueTime }, at('2026-09-01T00:00:00Z')))
    }
    return created
  }

  it('agree with core classification in the owner timezone', async () => {
    const tasks = await seedVariety()
    const ids = async (filter: 'today' | 'overdue' | 'upcoming' | 'no_date') =>
      (await asOwner((tx) => listTasks(tx, { filter, now: NOW, tz: LONDON }))).map((x) => x.title)
    expect(await ids('overdue')).toEqual(['overdue-date', 'overdue-timed-today'])
    expect(await ids('today')).toEqual(['today-later', 'today-untimed'])
    expect(await ids('upcoming')).toEqual(['tomorrow-midnight', 'upcoming-date'])
    expect(await ids('no_date')).toEqual(['no-date'])
    for (const task of tasks) {
      const group = classifyTaskDue(task, NOW, LONDON)
      const inFilter = await asOwner((tx) =>
        listTasks(tx, {
          filter: group === 'no_date' ? 'no_date' : group === 'done' ? 'done' : group,
          now: NOW,
          tz: LONDON,
        }),
      )
      expect(
        inFilter.map((x) => x.id),
        task.title,
      ).toContain(task.id)
    }
  })

  it('uses the next local midnight, not now + 24 h, on DST days', async () => {
    const spring = at('2026-03-29T12:00:00Z') // 23-hour day
    const a = await make({ title: 'late', dueDate: '2026-03-29', dueTime: '23:30' }, spring)
    const b = await make({ title: 'next', dueDate: '2026-03-30', dueTime: '00:30' }, spring)
    const today = await asOwner((tx) => listTasks(tx, { filter: 'today', now: spring, tz: LONDON }))
    expect(today.map((x) => x.id)).toEqual([a.id])
    const upcoming = await asOwner((tx) =>
      listTasks(tx, { filter: 'upcoming', now: spring, tz: LONDON }),
    )
    expect(upcoming.map((x) => x.id)).toEqual([b.id])
  })

  it('needs now and tz for date filters', async () => {
    await expect(asOwner((tx) => listTasks(tx, { filter: 'today' }))).rejects.toThrow(/needs now/)
  })

  it('hides unaccepted suggestions unless asked and filters by project', async () => {
    await make({ title: 'Suggested', source: 'email_suggestion', confirmed: false })
    await make({ title: 'Mine' })
    expect((await asOwner((tx) => listTasks(tx))).map((x) => x.title)).toEqual(['Mine'])
    expect(
      (await asOwner((tx) => listTasks(tx, { includeUnconfirmed: true })))
        .map((x) => x.title)
        .sort(),
    ).toEqual(['Mine', 'Suggested'])
    expect(await asOwner((tx) => listTasks(tx, { projectId: 'nope' }))).toEqual([])
    expect((await asOwner((tx) => listTasks(tx, { projectId: null }))).length).toBe(1)
  })

  it('lists done and cancelled tasks most recent first', async () => {
    const a = await make({ title: 'a' })
    const b = await make({ title: 'b' })
    const c = await make({ title: 'c' })
    await asOwner((tx) => completeTask(tx, a.id, at('2026-09-20T10:00:00Z')))
    await asOwner((tx) => completeTask(tx, b.id, at('2026-09-22T10:00:00Z')))
    await asOwner((tx) => cancelTask(tx, c.id, NOW))
    const done = await asOwner((tx) => listTasks(tx, { filter: 'done' }))
    expect(done.map((x) => x.title)).toEqual(['c', 'b', 'a'])
    expect(await asOwner((tx) => listTasks(tx, { filter: 'open' }))).toEqual([])
  })
})

describe('status transitions', () => {
  it('complete is idempotent and keeps the first completion time; reopen clears it', async () => {
    const task = await make({ title: 'Call bank' })
    const first = await asOwner((tx) => completeTask(tx, task.id, at('2026-09-24T12:00:00Z')))
    expect(first).toMatchObject({ ok: true, changed: true, task: { status: 'done' } })
    const again = await asOwner((tx) => completeTask(tx, task.id, at('2026-09-24T13:00:00Z')))
    expect(again).toMatchObject({ ok: true, changed: false })
    expect(again.ok && again.task.completedAt).toEqual(at('2026-09-24T12:00:00Z'))
    const reopened = await asOwner((tx) => reopenTask(tx, task.id, NOW))
    expect(reopened.ok && reopened.task).toMatchObject({ status: 'open', completedAt: null })
  })

  it('refuses done ↔ cancelled without reopening', async () => {
    const task = await make({ title: 'x' })
    await asOwner((tx) => completeTask(tx, task.id, NOW))
    expect(await asOwner((tx) => setTaskStatus(tx, task.id, 'cancel', NOW))).toMatchObject({
      ok: false,
      reason: 'invalid_transition',
    })
  })

  it('concurrent completes change the task once', async () => {
    const task = await make({ title: 'race' })
    const results = await Promise.all(
      Array.from({ length: 5 }, () => asOwner((tx) => completeTask(tx, task.id, NOW))),
    )
    expect(results.filter((r) => r.ok && r.changed)).toHaveLength(1)
  })
})

describe('deleteTask', () => {
  it('removes the task and its reminders, whichever path deletes it', async () => {
    const a = await make({ title: 'a', dueDate: '2026-09-25', dueTime: '10:00' })
    const b = await make({ title: 'b', dueDate: '2026-09-25', dueTime: '10:00' })
    for (const task of [a, b]) {
      await asOwner((tx) => updateTask(tx, task.id, {}, { ...ctx, reminder: { choice: 'at_due' } }))
    }
    const count = async () =>
      Number((await t.db<{ n: number }[]>`select count(*)::int as n from public.reminders`)[0]?.n)
    expect(await count()).toBe(2)
    expect(await asOwner((tx) => deleteTask(tx, a.id))).toBe(true)
    expect(await count()).toBe(1)
    await asOwner((tx) => tx`delete from public.tasks where id = ${b.id}`)
    expect(await count()).toBe(0)
    expect(await asOwner((tx) => deleteTask(tx, a.id))).toBe(false)
  })
})

describe('project options', () => {
  it('are empty while public.projects does not exist', async () => {
    expect(await asOwner((tx) => listTaskProjectOptions(tx))).toEqual([])
    expect(
      await asOwner((tx) => tasksProjectExists(tx, '5f0c7c7e-6c1c-4d0e-9d7a-0f6f4c1d2e3a')),
    ).toBe(false)
  })

  it('come from public.projects once it exists (RLS applies)', async () => {
    // Same shape as the capture area's table (20260924000500_projects_capture.sql).
    await t.db.unsafe(`
      create table if not exists public.projects (
        id uuid primary key default gen_random_uuid(),
        name text not null,
        kind text not null default 'personal',
        status text not null default 'active',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      select private.secure_owner_table('public.projects');
    `)
    try {
      const [p] = await t.db<{ id: string }[]>`
        insert into public.projects (name, status) values ('Garden', 'active'), ('Archive', 'done')
        returning id
      `
      const options = await asOwner((tx) => listTaskProjectOptions(tx))
      expect(options.map((o) => o.name)).toEqual(['Garden', 'Archive'])
      expect(await asStranger((tx) => listTaskProjectOptions(tx))).toEqual([])
      const r = await asOwner((tx) => createTask(tx, { title: 'Dig', projectId: p!.id }, ctx))
      expect(r.ok && r.task.projectId).toBe(p!.id)
      expect(
        (await asOwner((tx) => listTasks(tx, { projectId: p!.id }))).map((x) => x.title),
      ).toEqual(['Dig'])
    } finally {
      await t.db`delete from public.tasks`
      await t.db.unsafe('drop table public.projects')
    }
  })
})

describe('listNeedsAttention', () => {
  it('returns overdue tasks, due reminders and timed tasks due within 24 hours', async () => {
    const past = at('2026-09-01T00:00:00Z')
    const overdue = await make({ title: 'Overdue', dueDate: '2026-09-22' }, past)
    const soon = await make({ title: 'Soon', dueDate: '2026-09-25', dueTime: '09:00' }, past)
    await make({ title: 'Later', dueDate: '2026-09-26', dueTime: '09:00' }, past)
    await make({ title: 'Today untimed', dueDate: '2026-09-24' }, past)
    await make(
      { title: 'Suggested', dueDate: '2026-09-01', confirmed: false, source: 'email_suggestion' },
      past,
    )
    const done = await make({ title: 'Done', dueDate: '2026-09-01' }, past)
    await asOwner((tx) => completeTask(tx, done.id, past))
    // A due task reminder and one for a closed task.
    await t.db`
      insert into public.reminders (title, subject_kind, subject_id, remind_at) values
        ('Soon', 'task', ${soon.id}, '2026-09-24T11:00:00Z'),
        ('Done', 'task', ${done.id}, '2026-09-24T11:00:00Z')
    `
    await t.db`
      insert into public.reminders (title, remind_at, status) values
        ('Custom due', '2026-09-24T10:00:00Z', 'scheduled'),
        ('Custom later', '2026-09-24T18:00:00Z', 'scheduled'),
        ('Custom dismissed', '2026-09-24T09:00:00Z', 'dismissed')
    `
    const r = await asOwner((tx) => listNeedsAttention(tx, NOW, LONDON))
    expect(r.items.map((i) => `${i.kind}:${i.title}`)).toEqual([
      'task_overdue:Overdue',
      'reminder_due:Custom due',
      'reminder_due:Soon',
      'task_due_soon:Soon',
    ])
    expect(r.counts).toEqual({ overdue: 1, dueSoon: 1, reminders: 2 })
    const first = r.items[0]
    expect(first?.kind === 'task_overdue' && first.taskId).toBe(overdue.id)
    expect(first?.href).toBe(`/plan/tasks?task=${overdue.id}`)
  })
})
