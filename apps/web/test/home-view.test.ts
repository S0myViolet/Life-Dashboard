/**
 * Home view models (components/home/view.ts). Pure; synthetic data only.
 */
import { describe, expect, it } from 'vitest'
import {
  buildBriefingSkeletonContent,
  buildBriefingSourceFreshness,
  zonedLocalToUtc,
  type TasksNeedsAttention,
} from '@personal-home/core'
import type { PeopleAttention } from '@personal-home/db'
import {
  buildHomeAttention,
  buildHomeBriefing,
  buildHomeToday,
  type HomeBriefingRow,
} from '@/components/home/view'

const TZ = 'Europe/London'
const TODAY = '2026-09-24'
const at = (time: string, date = TODAY) => zonedLocalToUtc(date, time, TZ)
const NOW = at('10:00')

const tasksAttention: TasksNeedsAttention = {
  items: [
    {
      kind: 'task_overdue',
      key: 'task:a',
      taskId: 'a',
      title: 'Overdue report',
      dueDate: '2026-09-22',
      dueAt: null,
      priority: 1,
      projectId: null,
      href: '/plan/tasks?task=a',
    },
    {
      kind: 'reminder_due',
      key: 'reminder:r',
      reminderId: 'r',
      title: 'Bins',
      remindAt: at('09:30'),
      recurrence: null,
      subjectKind: 'custom',
      subjectId: null,
      href: '/plan/tasks#reminders',
    },
    {
      kind: 'task_due_soon',
      key: 'task:b',
      taskId: 'b',
      title: 'Call the bank',
      dueDate: TODAY,
      dueAt: at('14:30'),
      priority: null,
      projectId: null,
      href: '/plan/tasks?task=b',
    },
  ],
  counts: { overdue: 1, dueSoon: 1, reminders: 1 },
  truncated: false,
}

const peopleAttention: PeopleAttention = {
  today: TODAY,
  horizonDays: 60,
  upcomingDates: [
    {
      personId: 'p1',
      personName: 'Maya',
      dateId: 'd1',
      label: 'Birthday',
      month: 9,
      day: 29,
      year: 1994,
      date: '2026-09-29',
      daysUntil: 5,
      observedFromFeb29: false,
      years: 32,
      remindDaysBefore: 7,
      reminderDue: true,
    },
    {
      personId: 'p2',
      personName: 'Tom',
      dateId: 'd2',
      label: 'Anniversary',
      month: 10,
      day: 15,
      year: null,
      date: '2026-10-15',
      daysUntil: 21,
      observedFromFeb29: false,
      years: null,
      remindDaysBefore: 7,
      reminderDue: false,
    },
  ],
  dueCatchUps: [
    {
      personId: 'p1',
      personName: 'Maya',
      relationship: 'sister',
      catchUpEveryDays: 14,
      lastCaughtUpOn: '2026-09-04',
      dueOn: '2026-09-18',
      daysOverdue: 6,
      neverCaughtUp: false,
    },
  ],
}

describe('buildHomeAttention', () => {
  it('orders task items first, then dates in their reminder window, then catch-ups', () => {
    const view = buildHomeAttention({
      tasks: { ok: true, data: tasksAttention },
      people: { ok: true, data: peopleAttention },
      now: NOW,
      tz: TZ,
      limit: 10,
    })
    expect(view.items.map((i) => [i.kind, i.title, i.label, i.detail])).toEqual([
      ['task_overdue', 'Overdue report', 'Overdue', 'Was due Tue 22 Sep'],
      ['reminder_due', 'Bins', 'Reminder', 'Today · 09:30'],
      ['task_due_soon', 'Call the bank', 'Due soon', 'Due Today · 14:30'],
      ['person_date', 'Maya · Birthday', 'Coming up', 'In 5 days · Tue 29 Sep · turns 32'],
      ['catch_up', 'Catch up with Maya', 'Catch-up', '6 days overdue · every 14 days'],
    ])
    // Tom's anniversary is outside its 7-day reminder window: not an attention item.
    expect(view.items.some((i) => i.title.startsWith('Tom'))).toBe(false)
    expect(view.items.map((i) => i.href)).toEqual([
      '/plan/tasks?task=a',
      '/plan/tasks#reminders',
      '/plan/tasks?task=b',
      '/people/p1',
      '/people/p1',
    ])
    expect(view.more).toEqual({ tasks: 0, people: 0 })
    expect(view.sources).toEqual({ tasks: true, people: true })
  })

  it('reports what did not fit, using the complete task counts', () => {
    const view = buildHomeAttention({
      tasks: {
        ok: true,
        data: {
          ...tasksAttention,
          counts: { overdue: 4, dueSoon: 1, reminders: 1 },
          truncated: true,
        },
      },
      people: { ok: true, data: peopleAttention },
      now: NOW,
      tz: TZ,
      limit: 2,
    })
    expect(view.items).toHaveLength(2)
    expect(view.more).toEqual({ tasks: 4, people: 2 })
  })

  it('never hides a failed source behind an empty list', () => {
    const view = buildHomeAttention({
      tasks: { ok: false },
      people: { ok: true, data: { ...peopleAttention, upcomingDates: [], dueCatchUps: [] } },
      now: NOW,
      tz: TZ,
      limit: 6,
    })
    expect(view.items).toEqual([])
    expect(view.sources).toEqual({ tasks: false, people: true })
  })
})

describe('buildHomeToday', () => {
  it('lists open tasks, tasks completed today, and habits scheduled today', () => {
    const view = buildHomeToday({
      now: NOW,
      tz: TZ,
      limit: 1,
      openToday: {
        ok: true,
        data: [
          {
            id: 't1',
            title: 'Timed',
            status: 'open',
            dueAt: at('15:00'),
            priority: 1,
            completedAt: null,
          },
          {
            id: 't2',
            title: 'Dated',
            status: 'open',
            dueAt: null,
            priority: null,
            completedAt: null,
          },
        ],
      },
      recentlyDone: {
        ok: true,
        data: [
          {
            id: 't3',
            title: 'Done now',
            status: 'done',
            dueAt: null,
            priority: null,
            completedAt: at('08:00'),
          },
          {
            id: 't4',
            title: 'Done yesterday',
            status: 'done',
            dueAt: null,
            priority: null,
            completedAt: at('20:00', '2026-09-23'),
          },
          {
            id: 't5',
            title: 'Cancelled',
            status: 'cancelled',
            dueAt: null,
            priority: null,
            completedAt: null,
          },
        ],
      },
      habits: {
        ok: true,
        data: {
          // 24 Sep 2026 is a Thursday (ISO 4).
          habits: [
            { id: 'h1', title: 'Stretch', weekdays: [1, 2, 3, 4, 5, 6, 7], active: true },
            { id: 'h2', title: 'Long run', weekdays: [6], active: true },
            { id: 'h3', title: 'Old', weekdays: [4], active: false },
          ],
          doneToday: new Set(['h1']),
        },
      },
    })
    expect(view.today).toBe(TODAY)
    expect(view.tasks).toEqual({
      ok: true,
      data: {
        open: [
          {
            id: 't1',
            title: 'Timed',
            time: '15:00',
            priority: 1,
            done: false,
            href: '/plan/tasks?task=t1',
          },
        ],
        doneToday: [
          {
            id: 't3',
            title: 'Done now',
            time: null,
            priority: null,
            done: true,
            href: '/plan/tasks?task=t3',
          },
        ],
        more: 1,
      },
    })
    expect(view.habits).toEqual({
      ok: true,
      data: {
        due: [{ id: 'h1', title: 'Stretch', weekdaysLabel: 'Every day', done: true }],
        notDueCount: 1,
      },
    })
  })

  it('keeps each source’s failure separate', () => {
    const view = buildHomeToday({
      now: NOW,
      tz: TZ,
      limit: 5,
      openToday: { ok: true, data: [] },
      recentlyDone: { ok: false },
      habits: { ok: true, data: { habits: [], doneToday: new Set() } },
    })
    expect(view.tasks).toEqual({ ok: false })
    expect(view.habits).toEqual({ ok: true, data: { due: [], notDueCount: 0 } })
  })
})

describe('buildHomeBriefing', () => {
  const published = (over: Partial<HomeBriefingRow> = {}): HomeBriefingRow => ({
    kind: 'morning',
    localDate: TODAY,
    scheduledFor: at('11:00'),
    status: 'published',
    publishedAt: at('11:01'),
    isLate: false,
    content: buildBriefingSkeletonContent('morning', TODAY),
    sourceFreshness: buildBriefingSourceFreshness(),
    ...over,
  })

  it('shows the latest published briefing with its time and source freshness', () => {
    const view = buildHomeBriefing({
      latestPublished: published(),
      mostRecent: published(),
      now: at('12:00'),
      tz: TZ,
      timezoneConfirmed: true,
    })
    expect(view.latest).toMatchObject({
      title: 'Morning briefing',
      dateLabel: 'Today',
      publishedLabel: 'Published 11:01',
      late: false,
      stale: false,
      readable: true,
      sourceCount: 0,
      sourceNote: 'No connected sources are read by briefings until Milestone 2.',
    })
    expect(view.latest!.sections.length).toBeGreaterThan(0)
    expect(view.newerProblem).toBeNull()
    expect(view.nextLabel).toBe('Next project review: today at 22:00')
  })

  it('labels a late briefing and a stale one', () => {
    const late = buildHomeBriefing({
      latestPublished: published({ publishedAt: at('14:10'), isLate: true }),
      mostRecent: null,
      now: at('15:00'),
      tz: TZ,
      timezoneConfirmed: true,
    })
    expect(late.latest).toMatchObject({
      late: true,
      publishedLabel: 'Published 14:10',
      scheduledLabel: 'Scheduled for 11:00',
    })
    const stale = buildHomeBriefing({
      latestPublished: published({
        localDate: '2026-09-21',
        scheduledFor: at('11:00', '2026-09-21'),
        publishedAt: at('11:00', '2026-09-21'),
      }),
      mostRecent: null,
      now: NOW,
      tz: TZ,
      timezoneConfirmed: true,
    })
    expect(stale.latest).toMatchObject({ stale: true, dateLabel: 'Mon 21 Sep' })
  })

  it('says when a newer briefing failed, and never invents content', () => {
    const view = buildHomeBriefing({
      latestPublished: published({
        localDate: '2026-09-23',
        scheduledFor: at('22:00', '2026-09-23'),
        kind: 'evening',
        publishedAt: at('22:00', '2026-09-23'),
        content: { junk: true },
      }),
      mostRecent: { ...published(), status: 'failed', publishedAt: null },
      now: at('11:30'),
      tz: TZ,
      timezoneConfirmed: true,
    })
    expect(view.latest).toMatchObject({
      title: 'Evening project review',
      readable: false,
      summary: null,
      sections: [],
    })
    expect(view.newerProblem).toBe('The morning briefing for today could not be prepared.')
  })

  it('has no next time until the timezone is confirmed', () => {
    const view = buildHomeBriefing({
      latestPublished: null,
      mostRecent: null,
      now: at('23:00'),
      tz: TZ,
      timezoneConfirmed: false,
    })
    expect(view.latest).toBeNull()
    expect(view.nextLabel).toBeNull()
    const confirmed = buildHomeBriefing({
      latestPublished: null,
      mostRecent: null,
      now: at('23:00'),
      tz: TZ,
      timezoneConfirmed: true,
    })
    expect(confirmed.nextLabel).toBe('Next briefing: tomorrow at 11:00')
    expect(confirmed.scheduleLabel).toBe('11:00 briefing and 22:00 project review')
  })
})
