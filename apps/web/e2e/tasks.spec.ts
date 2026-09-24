/**
 * Plan › Tasks end to end: create/edit/complete/reopen with a due time in
 * Europe/London (from a browser in New York), overdue grouping, reminders, and
 * the 390px phone layout.
 *
 * Runs under the shared Playwright config (global setup seeds the owner and
 * exports PH_E2E_DATABASE). Tests share one database and run serially; each
 * starts from empty task tables.
 */
import { spawnSync } from 'node:child_process'
import { expect, test, type Locator, type Page } from '@playwright/test'

const TZ = 'Europe/London'

function sql(query: string): string {
  const database = process.env.PH_E2E_DATABASE
  if (!database) throw new Error('PH_E2E_DATABASE is not set; run through the Playwright config')
  const res = spawnSync(
    'psql',
    [
      '-X',
      '-q',
      '-t',
      '-A',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      '127.0.0.1',
      '-p',
      process.env.PH_PG_PORT ?? '54329',
      '-U',
      'postgres',
      '-d',
      database,
      '-c',
      query,
    ],
    { encoding: 'utf8' },
  )
  if (res.status !== 0) throw new Error(`psql failed: ${res.stderr}`)
  return res.stdout.trim()
}

/** The owner-local date in London, offset by whole days. */
function londonDate(offsetDays = 0): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  const d = new Date(`${today}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

/** Minutes until the next London midnight (tests that compare dates skip the last few). */
function minutesToLondonMidnight(): number {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(new Date())
    .split(':')
    .map(Number)
  return 24 * 60 - (h! * 60 + m!)
}

async function signIn(page: Page, next: string) {
  await page.goto(`/api/test/login?next=${encodeURIComponent(next)}`)
}

function group(page: Page, name: string): Locator {
  return page.getByRole('region', { name: new RegExp(`^${name}\\b`) })
}

test.beforeEach(() => {
  test.skip(minutesToLondonMidnight() < 3, 'Too close to midnight in London for date assertions')
  sql(`delete from public.reminders; delete from public.tasks;
       update public.owner_settings set timezone = '${TZ}';`)
})

test.describe('with a device clock in New York', () => {
  test.use({ timezoneId: 'America/New_York' })

  test('create, edit, complete (with undo) and reopen a task due at a London time', async ({
    page,
  }) => {
    const tomorrow = londonDate(1)
    await signIn(page, '/plan/tasks')
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible()
    await expect(page.getByText(`Dates and times are in ${TZ}.`)).toBeVisible()

    const add = page.getByRole('region', { name: 'Add a task' })
    await add.getByLabel('Task title').fill('Renew passport')
    await add.getByLabel('Due date', { exact: true }).fill(tomorrow)
    await add.getByLabel('Time (optional)').fill('14:30')
    await add.getByLabel('Priority').selectOption('2')
    await add.getByRole('button', { name: 'Add task' }).click()
    await expect(add.getByText('Added “Renew passport”.')).toBeVisible()
    // The form is cleared and ready for the next task.
    await expect(add.getByLabel('Task title')).toHaveValue('')
    await expect(add.getByLabel('Task title')).toBeFocused()

    const upcoming = group(page, 'Upcoming')
    const row = upcoming.getByRole('listitem').filter({ hasText: 'Renew passport' })
    await expect(row).toContainText('Tomorrow · 14:30')
    await expect(row).toContainText('P2')
    expect(
      sql(`select to_char(due_at at time zone 'Europe/London', 'YYYY-MM-DD HH24:MI'), due_date,
                  priority, status from public.tasks`),
    ).toBe(`${tomorrow} 14:30|${tomorrow}|2|open`)

    // Edit in the sheet.
    await row.getByRole('button', { name: 'Edit Renew passport', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: 'Edit task' })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByLabel('Title', { exact: true })).toHaveValue('Renew passport')
    await expect(sheet.getByLabel('Time (optional)')).toHaveValue('14:30')
    await sheet.getByLabel('Title', { exact: true }).fill('Renew passport (adult)')
    await sheet.getByLabel('Time (optional)').fill('09:15')
    await sheet.getByLabel('Duration (minutes, optional)').fill('45')
    await sheet.getByRole('button', { name: 'Save changes' }).click()
    await expect(sheet).toBeHidden()
    await expect(page.getByText('Saved “Renew passport (adult)”.')).toBeVisible()
    const edited = upcoming.getByRole('listitem').filter({ hasText: 'Renew passport (adult)' })
    await expect(edited).toContainText('Tomorrow · 09:15')
    await expect(edited).toContainText('45 min')
    expect(
      sql(`select title, to_char(due_at at time zone 'Europe/London', 'YYYY-MM-DD HH24:MI'),
                  duration_minutes from public.tasks`),
    ).toBe(`Renew passport (adult)|${tomorrow} 09:15|45`)

    // Complete, then undo from the toast.
    await edited.getByRole('button', { name: 'Complete Renew passport (adult)' }).click()
    await expect(page.getByText('Completed “Renew passport (adult)”.')).toBeVisible()
    await expect(group(page, 'Upcoming')).toHaveCount(0)
    await expect.poll(() => sql('select status from public.tasks')).toBe('done')
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(group(page, 'Upcoming').getByText('Renew passport (adult)')).toBeVisible()
    await expect
      .poll(() => sql('select status, completed_at is null from public.tasks'))
      .toBe('open|t')

    // Complete again and reopen it from the collapsed Done list.
    await page.getByRole('button', { name: 'Complete Renew passport (adult)' }).click()
    await expect.poll(() => sql('select status from public.tasks')).toBe('done')
    const done = page.locator('details', { has: page.getByRole('heading', { name: /^Done/ }) })
    await expect(done.getByRole('button', { name: 'Reopen Renew passport (adult)' })).toBeHidden()
    await done.locator('summary').click()
    await done.getByRole('button', { name: 'Reopen Renew passport (adult)' }).click()
    await expect(group(page, 'Upcoming').getByText('Renew passport (adult)')).toBeVisible()
    await expect.poll(() => sql('select status from public.tasks')).toBe('open')

    // Survives a reload.
    await page.reload()
    await expect(
      group(page, 'Upcoming').getByRole('listitem').filter({ hasText: 'Renew passport (adult)' }),
    ).toContainText('Tomorrow · 09:15')
  })

  test('shows validation errors inline and keeps what was typed', async ({ page }) => {
    const due = londonDate(2)
    await signIn(page, '/plan/tasks')
    const add = page.getByRole('region', { name: 'Add a task' })
    await add.getByLabel('Due date', { exact: true }).fill(due)
    await add.getByText('More options').click()
    await add.getByLabel('Duration (minutes, optional)').fill('3')
    await add.getByRole('button', { name: 'Add task' }).click()

    await expect(add.getByRole('alert')).toContainText('Check the highlighted fields.')
    const title = add.getByLabel('Task title')
    await expect(title).toHaveAttribute('aria-invalid', 'true')
    await expect(add.getByText('Give the task a title')).toBeVisible()
    await expect(title).toBeFocused()
    const duration = add.getByLabel('Duration (minutes, optional)')
    await expect(duration).toHaveAttribute('aria-invalid', 'true')
    await expect(add.getByText('Duration must be 5–720 minutes')).toBeVisible()
    await expect(duration).toHaveValue('3')
    await expect(add.getByLabel('Due date', { exact: true })).toHaveValue(due)
    expect(sql('select count(*) from public.tasks')).toBe('0')

    // A relative reminder needs a due time.
    await title.fill('Needs a time')
    await duration.fill('30')
    await add.getByLabel('Reminder', { exact: true }).selectOption('custom')
    await add.getByRole('button', { name: 'Add task' }).click()
    await expect(
      add.getByText('Pick a reminder date').or(add.getByText('Pick a reminder time')),
    ).toBeVisible()
    expect(sql('select count(*) from public.tasks')).toBe('0')
    await add.getByLabel('Reminder time').fill('09:00')
    await add.getByRole('button', { name: 'Add task' }).click()
    await expect(add.getByText('Added “Needs a time”.')).toBeVisible()
    expect(
      sql(`select duration_minutes, to_char(r.remind_at at time zone 'Europe/London', 'YYYY-MM-DD HH24:MI')
           from public.tasks t join public.reminders r on r.subject_id = t.id`),
    ).toBe(`30|${due} 09:00`)
  })
})

test('groups overdue, today, upcoming and undated tasks in the owner timezone', async ({
  page,
}) => {
  sql(`insert into public.tasks (title, due_date, due_at) values
         ('Pay council tax', '${londonDate(-1)}', null),
         ('Timed this morning', ((now() - interval '2 hours') at time zone 'Europe/London')::date,
            now() - interval '2 hours'),
         ('Water plants', '${londonDate(0)}', null),
         ('Book holiday', '${londonDate(3)}', null),
         ('Someday', null, null)`)
  await signIn(page, '/plan/tasks')

  const overdue = group(page, 'Overdue')
  await expect(overdue.getByRole('listitem')).toHaveCount(2)
  await expect(overdue).toContainText('Pay council tax')
  await expect(overdue).toContainText('Timed this morning')
  await expect(overdue.getByRole('listitem').filter({ hasText: 'Pay council tax' })).toContainText(
    'Yesterday',
  )
  await expect(group(page, 'Today').getByRole('listitem')).toHaveText([/Water plants/])
  await expect(group(page, 'Upcoming').getByRole('listitem')).toHaveText([/Book holiday/])
  await expect(group(page, 'No date').getByRole('listitem')).toHaveText([/Someday/])

  // Keyboard only: add with Enter, complete with the keyboard, focus is not lost.
  const title = page.getByLabel('Task title')
  await title.fill('Keyboard task')
  await title.press('Enter')
  await expect(group(page, 'No date').getByText('Keyboard task')).toBeVisible()
  const complete = page.getByRole('button', { name: 'Complete Keyboard task' })
  await complete.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Completed “Keyboard task”.')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.tagName ?? 'BODY'))
    .not.toBe('BODY')
  await expect
    .poll(() => sql(`select status from public.tasks where title = 'Keyboard task'`))
    .toBe('done')

  // A link to a task that no longer exists says so.
  await page.goto('/plan/tasks?task=5f0c7c7e-6c1c-4d0e-9d7a-0f6f4c1d2e3a')
  await expect(
    page.getByText('That task no longer exists or is older than the list shows.'),
  ).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Edit task' })).toHaveCount(0)
  await expect(page).toHaveURL(/\/plan\/tasks$/)
})

test('reminders: due ones can be dismissed; new ones use London time; tasks get reminders', async ({
  page,
}) => {
  const tomorrow = londonDate(1)
  sql(`insert into public.reminders (title, remind_at) values
         ('Take the bins out', now() - interval '5 minutes')`)
  await signIn(page, '/plan/tasks')
  const reminders = page.getByRole('region', { name: 'Reminders' })
  await expect(reminders.getByText('Due now')).toBeVisible()
  await reminders.getByRole('button', { name: 'Dismiss reminder: Take the bins out' }).click()
  await expect(reminders.getByText('Take the bins out')).toHaveCount(0)
  await expect.poll(() => sql('select status from public.reminders')).toBe('dismissed')

  await reminders.getByText('New reminder').click()
  await reminders.getByLabel('Remind me to').fill('Call the dentist')
  await reminders.getByLabel('Date', { exact: true }).fill(tomorrow)
  await reminders.getByLabel('Time', { exact: true }).fill('08:00')
  await reminders.getByRole('button', { name: 'Add reminder' }).click()
  await expect(reminders.getByText('Reminder set for Tomorrow · 08:00.')).toBeVisible()
  await expect(
    reminders.getByRole('listitem').filter({ hasText: 'Call the dentist' }),
  ).toContainText('Tomorrow · 08:00')
  expect(
    sql(`select to_char(remind_at at time zone 'Europe/London', 'YYYY-MM-DD HH24:MI')
         from public.reminders where title = 'Call the dentist'`),
  ).toBe(`${tomorrow} 08:00`)
  await reminders.getByRole('button', { name: 'Delete reminder: Call the dentist' }).click()
  await reminders
    .getByRole('button', { name: 'Confirm deleting reminder: Call the dentist' })
    .click()
  await expect(reminders.getByText('Call the dentist')).toHaveCount(0)
  await expect
    .poll(() => sql(`select count(*) from public.reminders where title = 'Call the dentist'`))
    .toBe('0')

  // A task with a reminder one hour before its due time.
  const add = page.getByRole('region', { name: 'Add a task' })
  await add.getByLabel('Task title').fill('Buy flowers')
  await add.getByLabel('Due date', { exact: true }).fill(tomorrow)
  await add.getByLabel('Time (optional)').fill('10:00')
  await add.getByText('More options').click()
  await add.getByLabel('Reminder', { exact: true }).selectOption('1h')
  await add.getByRole('button', { name: 'Add task' }).click()
  await expect(add.getByText('Reminder set for Tomorrow · 09:00.')).toBeVisible()
  await expect(
    group(page, 'Upcoming').getByRole('listitem').filter({ hasText: 'Buy flowers' }),
  ).toContainText('Tomorrow · 09:00')
  await expect(
    reminders.getByRole('listitem').filter({ hasText: 'Buy flowers' }).getByRole('link', {
      name: 'Open task: Buy flowers',
    }),
  ).toBeVisible()
  expect(
    sql(`select subject_kind, to_char(remind_at at time zone 'Europe/London', 'YYYY-MM-DD HH24:MI')
         from public.reminders where title = 'Buy flowers'`),
  ).toBe(`task|${tomorrow} 09:00`)

  // The reminder's link opens the task's edit sheet.
  await reminders.getByRole('link', { name: 'Open task: Buy flowers' }).click()
  await expect(page.getByRole('dialog', { name: 'Edit task' })).toBeVisible()
  await expect(page.getByLabel('Reminder', { exact: true })).toHaveValue('keep')
})

test.describe('on a 390px phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the tasks screen fits, has 44px targets and works by touch', async ({ page }) => {
    await signIn(page, '/plan/tasks')
    const scrollWidth = () => page.evaluate(() => document.documentElement.scrollWidth)
    expect(await scrollWidth()).toBeLessThanOrEqual(390)

    const add = page.getByRole('region', { name: 'Add a task' })
    await add.getByLabel('Task title').fill('Phone task')
    await add.getByRole('button', { name: 'Tomorrow' }).tap()
    await expect(add.getByLabel('Due date', { exact: true })).toHaveValue(londonDate(1))
    await add.getByLabel('Time (optional)').fill('07:45')
    await add.getByRole('button', { name: 'Add task' }).tap()
    const row = group(page, 'Upcoming').getByRole('listitem').filter({ hasText: 'Phone task' })
    await expect(row).toContainText('Tomorrow · 07:45')
    await add.getByText('More options').tap()
    expect(await scrollWidth()).toBeLessThanOrEqual(390)

    const targets = [
      row.getByRole('button', { name: 'Complete Phone task' }),
      add.getByRole('button', { name: 'Add task' }),
      add.getByLabel('Task title'),
      add.getByLabel('Priority'),
      add.getByRole('button', { name: 'Tomorrow' }),
    ]
    for (const target of targets) {
      const box = await target.boundingBox()
      expect(box, String(target)).not.toBeNull()
      expect(box!.height, String(target)).toBeGreaterThanOrEqual(44)
    }
    const toggle = await row.getByRole('button', { name: 'Complete Phone task' }).boundingBox()
    expect(toggle!.width).toBeGreaterThanOrEqual(44)

    // The edit sheet fits the screen.
    await row.getByRole('button', { name: 'Edit Phone task' }).tap()
    const sheet = page.getByRole('dialog', { name: 'Edit task' })
    await expect(sheet).toBeVisible()
    const box = await sheet.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
    await sheet.getByRole('button', { name: 'Close' }).tap()
    await expect(sheet).toBeHidden()

    await row.getByRole('button', { name: 'Complete Phone task' }).tap()
    await expect(page.getByText('Completed “Phone task”.')).toBeVisible()
    await expect.poll(() => sql('select status from public.tasks')).toBe('done')
    // Bottom navigation stays reachable.
    await expect(
      page.getByRole('navigation', { name: 'Main' }).filter({ visible: true }),
    ).toBeVisible()
  })
})
