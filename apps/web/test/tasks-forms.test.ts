/** FormData parsing and owner-timezone labels for the tasks screens (no database). */
import { describe, expect, it } from 'vitest'
import {
  dstNotice,
  formatDueLabel,
  formatLongDate,
  formatRelativeDate,
  formatShortDate,
} from '@/lib/tasks/format'
import { formValues, parseHabitForm, parseReminderForm, parseTaskForm } from '@/lib/tasks/forms'

function form(fields: Record<string, string | string[] | Blob>): FormData {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) {
    if (value instanceof Blob) data.append(name, value)
    else for (const v of Array.isArray(value) ? value : [value]) data.append(name, v)
  }
  return data
}

describe('parseTaskForm', () => {
  it('turns blanks into "not given" and numbers into numbers', () => {
    const r = parseTaskForm(
      form({
        title: 'x',
        dueDate: '',
        dueTime: '',
        priority: '',
        durationMinutes: '',
        details: '',
        reminder: 'none',
      }),
      'create',
    )
    expect(r).toEqual({
      ok: true,
      value: {
        fields: {
          title: 'x',
          details: null,
          priority: null,
          dueDate: null,
          dueTime: null,
          durationMinutes: null,
          splittable: false,
        },
        reminder: { choice: 'none', date: null, time: null },
      },
    })
  })

  it('keeps the project and details when the edit form does not post them', () => {
    const r = parseTaskForm(form({ title: 'x', priority: '3', durationMinutes: '90' }), 'update')
    expect(r.ok && r.value.fields).toEqual({
      title: 'x',
      priority: 3,
      dueDate: null,
      dueTime: null,
      durationMinutes: 90,
      splittable: false,
    })
    expect(r.ok && r.value.reminder.choice).toBe('keep')
    const cleared = parseTaskForm(form({ title: 'x', projectId: '' }), 'update')
    expect(cleared.ok && cleared.value.fields.projectId).toBeNull()
  })

  it('treats "keep" on the add form as no reminder and rejects junk', () => {
    const r = parseTaskForm(form({ title: 'x', reminder: 'keep' }), 'create')
    expect(r.ok && r.value.reminder.choice).toBe('none')
    expect(parseTaskForm(form({ title: 'x', durationMinutes: '1.5' }), 'create')).toEqual({
      ok: false,
      fieldErrors: { durationMinutes: 'Enter the duration in whole minutes' },
    })
    expect(parseTaskForm(form({ title: 'x', priority: '0' }), 'create').ok).toBe(false)
  })

  it('ignores file uploads posted in place of text', () => {
    const r = parseTaskForm(form({ title: new Blob(['x']) }), 'create')
    expect(r.ok && r.value.fields.title).toBe('')
  })
})

describe('parseReminderForm and parseHabitForm', () => {
  it('parses reminders', () => {
    expect(
      parseReminderForm(form({ title: 't', date: '2026-10-01', time: '08:00', recurrence: '' })),
    ).toEqual({
      ok: true,
      value: { title: 't', date: '2026-10-01', time: '08:00', recurrence: null },
    })
    expect(
      parseReminderForm(form({ title: 't', date: '2026-10-01', time: '08:00', recurrence: 'x' }))
        .ok,
    ).toBe(false)
  })

  it('parses habit weekdays', () => {
    expect(parseHabitForm(form({ title: 'h', weekdays: ['1', '7'] }))).toEqual({
      ok: true,
      value: { title: 'h', details: null, weekdays: [1, 7] },
    })
    expect(parseHabitForm(form({ title: 'h' })).ok).toBe(false)
  })

  it('echoes submitted values for refilling a form', () => {
    expect(
      formValues(form({ title: 'a', weekdays: ['1', '3'], other: 'x' }), ['title', 'weekdays']),
    ).toEqual({
      title: 'a',
      weekdays: '1,3',
    })
  })
})

describe('labels in the owner timezone', () => {
  const now = new Date('2026-09-24T12:00:00Z')

  it('formats dates without depending on ICU month names', () => {
    expect(formatShortDate('2026-09-24')).toBe('Thu 24 Sep')
    expect(formatShortDate('2027-01-02', '2026-09-24')).toBe('Sat 2 Jan 2027')
    expect(formatLongDate('2026-09-24')).toBe('Thursday 24 September')
    expect(formatRelativeDate('2026-09-25', '2026-09-24')).toBe('Tomorrow')
    expect(formatRelativeDate('2026-09-23', '2026-09-24')).toBe('Yesterday')
  })

  it('shows due times in the owner zone, not the server zone', () => {
    const task = { dueDate: '2026-09-24', dueAt: new Date('2026-09-24T22:30:00Z') }
    expect(formatDueLabel(task, now, 'Europe/London')).toBe('Today · 23:30')
    expect(formatDueLabel(task, now, 'Asia/Tokyo')).toBe('Tomorrow · 07:30')
    expect(formatDueLabel({ dueDate: null, dueAt: null }, now, 'Europe/London')).toBeNull()
  })

  it('explains DST adjustments', () => {
    expect(
      dstNotice({ date: '2027-03-28', time: '01:30' }, { shiftedTo: '02:30' }, 'Europe/London'),
    ).toContain('saved as 02:30')
    expect(
      dstNotice(
        { date: '2026-10-25', time: '01:30' },
        { shiftedTo: null, ambiguous: true },
        'Europe/London',
      ),
    ).toContain('happens twice')
    expect(dstNotice({ date: '2026-10-01', time: '09:00' }, { shiftedTo: null }, 'UTC')).toBeNull()
  })
})
