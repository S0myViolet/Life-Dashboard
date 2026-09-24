import { describe, expect, it } from 'vitest'
import {
  TaskCreateInputSchema,
  TaskUpdateInputSchema,
  classifyTaskDue,
  compareTasksByDue,
  formatTaskDuration,
  groupTasksByDue,
  resolveTaskDue,
  taskDueFormValues,
  taskDueWindows,
  taskStatusTransition,
  tasksCleanMultiline,
  tasksCleanTitle,
  type TaskSortFields,
} from '../src/index.ts'

const LONDON = 'Europe/London'
const at = (s: string) => new Date(s)

describe('task text clean-up', () => {
  it('collapses control characters and whitespace in titles', () => {
    expect(tasksCleanTitle('  Pay\u0000 the\t\tcouncil\n tax  ')).toBe('Pay the council tax')
    expect(tasksCleanTitle('a\u2028b')).toBe('a b')
  })
  it('keeps newlines and tabs in details but drops other control characters', () => {
    expect(tasksCleanMultiline('line 1\r\nline\u0007 2\n\tindented  ')).toBe(
      'line 1\nline 2\n\tindented',
    )
  })
})

describe('TaskCreateInputSchema', () => {
  it('accepts a full task and normalises the title', () => {
    const parsed = TaskCreateInputSchema.parse({
      title: '  Book   dentist ',
      details: '  ',
      projectId: null,
      priority: 2,
      dueDate: '2026-10-01',
      dueTime: '09:30',
      durationMinutes: 45,
      splittable: true,
    })
    expect(parsed).toMatchObject({
      title: 'Book dentist',
      details: null,
      priority: 2,
      dueDate: '2026-10-01',
      dueTime: '09:30',
      durationMinutes: 45,
      splittable: true,
    })
  })

  it('rejects empty and over-long titles', () => {
    expect(TaskCreateInputSchema.safeParse({ title: ' \t ' }).success).toBe(false)
    expect(TaskCreateInputSchema.safeParse({ title: 'x'.repeat(300) }).success).toBe(true)
    expect(TaskCreateInputSchema.safeParse({ title: 'x'.repeat(301) }).success).toBe(false)
  })

  it('bounds priority (1–4) and duration (5–720 whole minutes)', () => {
    for (const priority of [0, 5, 1.5, '1']) {
      expect(
        TaskCreateInputSchema.safeParse({ title: 't', priority }).success,
        String(priority),
      ).toBe(false)
    }
    for (const durationMinutes of [4, 721, 30.5]) {
      expect(TaskCreateInputSchema.safeParse({ title: 't', durationMinutes }).success).toBe(false)
    }
    expect(TaskCreateInputSchema.safeParse({ title: 't', durationMinutes: 5 }).success).toBe(true)
    expect(TaskCreateInputSchema.safeParse({ title: 't', durationMinutes: 720 }).success).toBe(true)
  })

  it('rejects impossible dates, bad times and a time without a date', () => {
    expect(TaskCreateInputSchema.safeParse({ title: 't', dueDate: '2026-02-30' }).success).toBe(
      false,
    )
    expect(
      TaskCreateInputSchema.safeParse({ title: 't', dueDate: '2026-02-03', dueTime: '24:00' })
        .success,
    ).toBe(false)
    const r = TaskCreateInputSchema.safeParse({ title: 't', dueTime: '09:00' })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]?.path).toEqual(['dueTime'])
  })

  it('only accepts https provenance links', () => {
    const ok = TaskCreateInputSchema.safeParse({
      title: 't',
      sourceRef: { kind: 'email', id: 'abc', url: 'https://mail.google.com/x' },
    })
    expect(ok.success).toBe(true)
    for (const url of ['javascript:alert(1)', 'http://example.com']) {
      expect(
        TaskCreateInputSchema.safeParse({ title: 't', sourceRef: { kind: 'email', url } }).success,
      ).toBe(false)
    }
    expect(
      TaskCreateInputSchema.safeParse({ title: 't', sourceRef: { kind: 'email', extra: 1 } })
        .success,
    ).toBe(false)
  })
})

describe('TaskUpdateInputSchema', () => {
  it('treats undefined as keep and null as clear', () => {
    expect(TaskUpdateInputSchema.parse({ priority: null })).toEqual({ priority: null })
    expect(TaskUpdateInputSchema.parse({})).toEqual({})
  })
  it('requires the due date whenever the due time is sent', () => {
    expect(TaskUpdateInputSchema.safeParse({ dueTime: '10:00' }).success).toBe(false)
    expect(TaskUpdateInputSchema.safeParse({ dueTime: null }).success).toBe(false)
    expect(TaskUpdateInputSchema.safeParse({ dueDate: '2026-10-01', dueTime: null }).success).toBe(
      true,
    )
  })
})

describe('resolveTaskDue (owner timezone, DST-safe)', () => {
  it('stores date-only tasks without an instant', () => {
    expect(resolveTaskDue({ dueDate: '2026-10-01' }, LONDON)).toEqual({
      ok: true,
      due: { dueDate: '2026-10-01', dueAt: null, shiftedTo: null, ambiguous: false },
    })
    expect(resolveTaskDue({}, LONDON)).toMatchObject({
      ok: true,
      due: { dueDate: null, dueAt: null },
    })
  })

  it('converts a local time in BST and GMT', () => {
    const summer = resolveTaskDue({ dueDate: '2026-09-25', dueTime: '14:30' }, LONDON)
    expect(summer.ok && summer.due.dueAt?.toISOString()).toBe('2026-09-25T13:30:00.000Z')
    const winter = resolveTaskDue({ dueDate: '2026-12-01', dueTime: '14:30' }, LONDON)
    expect(winter.ok && winter.due.dueAt?.toISOString()).toBe('2026-12-01T14:30:00.000Z')
  })

  it('moves a time in the spring-forward gap forward and says so', () => {
    const r = resolveTaskDue({ dueDate: '2026-03-29', dueTime: '01:30' }, LONDON)
    expect(r).toEqual({
      ok: true,
      due: {
        dueDate: '2026-03-29',
        dueAt: at('2026-03-29T01:30:00Z'),
        shiftedTo: '02:30',
        ambiguous: false,
      },
    })
  })

  it('uses the first of two identical wall times on the fall-back day and flags it', () => {
    const r = resolveTaskDue({ dueDate: '2026-10-25', dueTime: '01:30' }, LONDON)
    expect(r).toEqual({
      ok: true,
      due: {
        dueDate: '2026-10-25',
        dueAt: at('2026-10-25T00:30:00Z'),
        shiftedTo: null,
        ambiguous: true,
      },
    })
    const plain = resolveTaskDue({ dueDate: '2026-10-25', dueTime: '03:00' }, LONDON)
    expect(plain.ok && plain.due.ambiguous).toBe(false)
  })

  it('refuses a date that does not exist in the zone', () => {
    // Samoa skipped 30 December 2011 when it moved across the date line.
    const r = resolveTaskDue({ dueDate: '2011-12-30', dueTime: '12:00' }, 'Pacific/Apia')
    expect(r.ok).toBe(false)
  })

  it('refuses a time without a date', () => {
    expect(resolveTaskDue({ dueTime: '09:00' }, LONDON).ok).toBe(false)
  })

  it('round-trips into edit-form values in the owner zone', () => {
    expect(
      taskDueFormValues({ dueDate: '2026-09-25', dueAt: at('2026-09-25T13:30:00Z') }, LONDON),
    ).toEqual({
      dueDate: '2026-09-25',
      dueTime: '14:30',
    })
    // After a timezone change the instant is kept and shown in the new zone.
    expect(
      taskDueFormValues(
        { dueDate: '2026-09-25', dueAt: at('2026-09-25T13:30:00Z') },
        'America/New_York',
      ),
    ).toEqual({ dueDate: '2026-09-25', dueTime: '09:30' })
    expect(taskDueFormValues({ dueDate: '2026-09-25', dueAt: null }, LONDON)).toEqual({
      dueDate: '2026-09-25',
      dueTime: '',
    })
  })
})

describe('classifyTaskDue', () => {
  const open = (dueDate: string | null, dueAt: string | null = null) => ({
    status: 'open' as const,
    dueDate,
    dueAt: dueAt ? at(dueAt) : null,
  })
  const now = at('2026-09-24T12:00:00Z') // 13:00 BST on Thursday 24 September

  it('groups date-only tasks by the owner-local date', () => {
    expect(classifyTaskDue(open('2026-09-23'), now, LONDON)).toBe('overdue')
    expect(classifyTaskDue(open('2026-09-24'), now, LONDON)).toBe('today')
    expect(classifyTaskDue(open('2026-09-25'), now, LONDON)).toBe('upcoming')
    expect(classifyTaskDue(open(null), now, LONDON)).toBe('no_date')
  })

  it('makes timed tasks overdue once their time has passed', () => {
    expect(classifyTaskDue(open('2026-09-24', '2026-09-24T08:00:00Z'), now, LONDON)).toBe('overdue')
    expect(classifyTaskDue(open('2026-09-24', '2026-09-24T17:00:00Z'), now, LONDON)).toBe('today')
    expect(classifyTaskDue(open('2026-09-24', '2026-09-24T22:59:00Z'), now, LONDON)).toBe('today')
    // 00:00 BST on the 25th is tomorrow.
    expect(classifyTaskDue(open('2026-09-25', '2026-09-24T23:00:00Z'), now, LONDON)).toBe(
      'upcoming',
    )
  })

  it('closed tasks are done regardless of dates', () => {
    expect(
      classifyTaskDue({ status: 'done', dueDate: '2020-01-01', dueAt: null }, now, LONDON),
    ).toBe('done')
    expect(classifyTaskDue({ status: 'cancelled', dueDate: null, dueAt: null }, now, LONDON)).toBe(
      'done',
    )
  })

  it('depends on the owner timezone around midnight', () => {
    const late = at('2026-06-15T23:30:00Z') // 00:30 on the 16th in London, still the 15th in UTC
    expect(classifyTaskDue(open('2026-06-15'), late, LONDON)).toBe('overdue')
    expect(classifyTaskDue(open('2026-06-15'), late, 'UTC')).toBe('today')
    expect(classifyTaskDue(open('2026-06-16'), late, LONDON)).toBe('today')
  })

  it('handles the 23-hour and 25-hour days', () => {
    // Spring forward: 29 March 2026 is 23 hours long in London.
    const spring = at('2026-03-29T12:00:00Z')
    expect(taskDueWindows(spring, LONDON)).toEqual({
      today: '2026-03-29',
      tomorrowStart: at('2026-03-29T23:00:00Z'),
    })
    expect(classifyTaskDue(open('2026-03-29', '2026-03-29T22:59:00Z'), spring, LONDON)).toBe(
      'today',
    )
    expect(classifyTaskDue(open('2026-03-30', '2026-03-29T23:00:00Z'), spring, LONDON)).toBe(
      'upcoming',
    )
    // Fall back: 25 October 2026 is 25 hours long.
    const autumn = at('2026-10-25T12:00:00Z')
    expect(taskDueWindows(autumn, LONDON)).toEqual({
      today: '2026-10-25',
      tomorrowStart: at('2026-10-26T00:00:00Z'),
    })
    expect(classifyTaskDue(open('2026-10-25', '2026-10-25T23:30:00Z'), autumn, LONDON)).toBe(
      'today',
    )
  })

  it('agrees with taskDueWindows for timed tasks', () => {
    const now2 = at('2026-10-25T00:45:00Z') // 01:45 BST, first pass through the repeated hour
    const { tomorrowStart } = taskDueWindows(now2, LONDON)
    for (let h = 0; h < 50; h++) {
      const dueAt = new Date(now2.getTime() + h * 3_600_000)
      const group = classifyTaskDue(open('x', dueAt.toISOString()), now2, LONDON)
      expect(group).toBe(dueAt < tomorrowStart ? 'today' : 'upcoming')
    }
  })
})

describe('groupTasksByDue', () => {
  const base = { createdAt: at('2026-09-01T00:00:00Z'), completedAt: null }
  const t = (id: string, over: Partial<TaskSortFields>): TaskSortFields => ({
    id,
    status: 'open',
    dueDate: null,
    dueAt: null,
    priority: null,
    ...base,
    ...over,
  })
  const now = at('2026-09-24T12:00:00Z')

  it('groups and orders tasks for display', () => {
    const tasks = [
      t('nodate-p4', { priority: 4 }),
      t('nodate-none', {}),
      t('nodate-p1', { priority: 1 }),
      t('today-untimed-p1', { dueDate: '2026-09-24', priority: 1 }),
      t('today-17', { dueDate: '2026-09-24', dueAt: at('2026-09-24T16:00:00Z') }),
      t('today-15', { dueDate: '2026-09-24', dueAt: at('2026-09-24T14:00:00Z'), priority: 3 }),
      t('overdue-old', { dueDate: '2026-09-01' }),
      t('overdue-morning', { dueDate: '2026-09-24', dueAt: at('2026-09-24T08:00:00Z') }),
      t('upcoming', { dueDate: '2026-09-30' }),
      t('done-old', { status: 'done', completedAt: at('2026-09-20T10:00:00Z') }),
      t('done-new', { status: 'done', completedAt: at('2026-09-23T10:00:00Z') }),
    ]
    const g = groupTasksByDue(tasks, now, LONDON)
    const ids = (k: keyof typeof g) => g[k].map((x) => x.id)
    expect(ids('overdue')).toEqual(['overdue-old', 'overdue-morning'])
    expect(ids('today')).toEqual(['today-15', 'today-17', 'today-untimed-p1'])
    expect(ids('upcoming')).toEqual(['upcoming'])
    expect(ids('no_date')).toEqual(['nodate-p1', 'nodate-p4', 'nodate-none'])
    expect(ids('done')).toEqual(['done-new', 'done-old'])
  })

  it('compareTasksByDue puts dated tasks before undated ones', () => {
    expect(compareTasksByDue(t('a', { dueDate: '2030-01-01' }), t('b', {}))).toBeLessThan(0)
  })
})

describe('taskStatusTransition', () => {
  it('allows complete/reopen/cancel and makes repeats no-ops', () => {
    expect(taskStatusTransition('open', 'complete')).toEqual({
      ok: true,
      status: 'done',
      changed: true,
    })
    expect(taskStatusTransition('done', 'complete')).toEqual({
      ok: true,
      status: 'done',
      changed: false,
    })
    expect(taskStatusTransition('done', 'reopen')).toEqual({
      ok: true,
      status: 'open',
      changed: true,
    })
    expect(taskStatusTransition('cancelled', 'reopen')).toEqual({
      ok: true,
      status: 'open',
      changed: true,
    })
    expect(taskStatusTransition('open', 'reopen')).toEqual({
      ok: true,
      status: 'open',
      changed: false,
    })
    expect(taskStatusTransition('open', 'cancel')).toEqual({
      ok: true,
      status: 'cancelled',
      changed: true,
    })
    expect(taskStatusTransition('cancelled', 'cancel')).toEqual({
      ok: true,
      status: 'cancelled',
      changed: false,
    })
  })
  it('refuses done ↔ cancelled without reopening first', () => {
    expect(taskStatusTransition('cancelled', 'complete').ok).toBe(false)
    expect(taskStatusTransition('done', 'cancel').ok).toBe(false)
  })
})

describe('formatTaskDuration', () => {
  it('formats minutes and hours', () => {
    expect(formatTaskDuration(5)).toBe('5 min')
    expect(formatTaskDuration(60)).toBe('1 h')
    expect(formatTaskDuration(90)).toBe('1 h 30 min')
    expect(formatTaskDuration(720)).toBe('12 h')
  })
})
