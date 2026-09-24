/**
 * Home end to end (desktop and the iPhone-sized project) against a production build with the
 * test-only sign-in: honest empty states for a fresh owner, the morning flow (quick-add a timed
 * task → Needs attention and Today → the plan card proposes a replan → accept a block → reload),
 * habit and task check-off, reading log and quick note from quick capture, saved module order
 * and hidden modules, and the phone layout with labelled demo data. All data is synthetic.
 *
 * Most tests set the owner's timezone to a fixed-offset zone where it is late morning, so
 * "today", "due within 24 hours" and "not in the past" hold whatever time the suite runs.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { resetOwnerSettings, signInAsOwner, sql } from './helpers'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** A fixed-offset IANA zone (Etc/GMT±N) in which it is currently about 10:00. */
function lateMorningZone(): { tz: string; today: string } {
  const now = new Date()
  let offset = 10 - now.getUTCHours()
  if (offset > 14) offset -= 24
  if (offset < -12) offset += 24
  // Etc/GMT signs are inverted: Etc/GMT-3 is UTC+3.
  const tz = offset === 0 ? 'Etc/UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`
  return { tz, today: new Date(now.getTime() + offset * 3_600_000).toISOString().slice(0, 10) }
}

const ALL_DAY = JSON.stringify(
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '00:00', end: '24:00' })),
)

function clearHomeData() {
  sql(
    `delete from public.daily_plans; delete from public.learning_goals; delete from public.tasks;
     delete from public.reminders; delete from public.habits; delete from public.books;
     delete from public.people; delete from public.briefings;`,
  )
}

/** Late-morning zone, confirmed, optionally with all-day available hours. */
function morningOwner(opts: { hours?: boolean } = {}) {
  const zone = lateMorningZone()
  sql(
    `update public.owner_settings set timezone = '${zone.tz}', timezone_confirmed = true,
       available_hours = ${opts.hours ? `'${ALL_DAY}'::jsonb` : 'null'}, home_layout = '[]'::jsonb`,
  )
  return zone
}

async function expectNoHorizontalScroll(page: Page, where: string) {
  // Measure the settled page: streamed sections replace their placeholders first.
  await page.waitForLoadState('networkidle')
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0)
  const { overflow, culprits } = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    // The innermost elements that stick out: those are what forces the page wider.
    const wide = [...document.querySelectorAll('main *')].filter(
      (el) => el.getBoundingClientRect().right > vw + 0.5,
    )
    const culprits = wide
      .filter((el) => !wide.some((other) => other !== el && el.contains(other)))
      .slice(0, 5)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}[${Math.round(el.getBoundingClientRect().width)}px] "${(el.textContent ?? '').trim().slice(0, 40)}"`,
      )
    return { overflow: document.documentElement.scrollWidth - vw, culprits }
  })
  expect(overflow, `${where}: ${culprits.join(', ')}`).toBeLessThanOrEqual(0)
}

/** Module ids in page order, once every module has replaced its loading placeholder. */
async function moduleIds(page: Page, count: number) {
  const modules = page.locator('[data-home-module]:visible')
  await expect(modules).toHaveCount(count)
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0)
  return modules.evaluateAll((els) => els.map((e) => e.getAttribute('data-home-module')))
}

test.beforeEach(() => {
  clearHomeData()
  resetOwnerSettings()
})

test.afterAll(() => {
  clearHomeData()
  resetOwnerSettings()
})

test('a fresh owner sees honest empty states in every module', async ({ page }) => {
  await signInAsOwner(page)
  await expect(page).toHaveURL(/\/$/)
  expect(await moduleIds(page, 7)).toEqual([
    'needs-attention',
    'todays-plan',
    'today',
    'briefing',
    'health-preview',
    'money-preview',
    'interests',
  ])

  // Needs attention: checked sources are empty, and it says which ones are not connected.
  const attention = page.locator('[data-home-module="needs-attention"]')
  await expect(attention.getByTestId('attention-empty')).toHaveText(
    /Nothing in your tasks or reminders is overdue or due in the next 24 hours/,
  )
  await expect(attention.getByTestId('attention-sources')).toContainText(
    'Deadlines from email and calendars are not connected yet (Milestone 2)',
  )

  // The planner's card drafts an empty plan and does not invent priorities.
  const plan = page.locator('[data-home-module="todays-plan"]')
  await expect(plan.getByText('Nothing pressing today.')).toBeVisible()
  await expect(plan.getByTestId('plan-hours')).toContainText('No available hours are set')

  const today = page.locator('[data-home-module="today"]')
  await expect(today.getByTestId('today-tasks-empty')).toContainText('No tasks are due today.')
  await expect(today.getByTestId('today-habits-empty')).toContainText('No habits yet.')
  await expect(today).toContainText('Calendar events are not shown yet')

  const briefing = page.locator('[data-home-module="briefing"]')
  await expect(briefing.getByTestId('briefing-none')).toContainText(
    'Your first briefing is published at 11:00 once your timezone is confirmed.',
  )
  await expect(briefing.getByText('Nothing yet', { exact: true })).toBeVisible()

  for (const id of ['health-preview', 'money-preview', 'interests']) {
    await expect(page.locator(`[data-home-module="${id}"]`)).toContainText('Planned · Milestone 3')
  }

  // Quick capture: no book to log against yet, said plainly.
  const capture = page.getByRole('region', { name: 'Quick capture' })
  await capture.getByRole('tab', { name: 'Reading' }).click()
  await expect(capture.getByTestId('quick-reading-empty')).toContainText(
    'No books on your reading list yet.',
  )

  await expect(page.getByTestId('demo-notice')).toHaveCount(0)
  const text = await page.getByRole('main').innerText()
  expect(text).not.toMatch(/all caught up|nothing needs attention|no events today|all clear\b/i)
  await expectNoHorizontalScroll(page, 'fresh home')
})

test('quick-add a timed task: Needs attention, Today, then the plan card replans and a block is accepted', async ({
  page,
}) => {
  morningOwner({ hours: true })
  await signInAsOwner(page)
  const plan = page.locator('[data-home-module="todays-plan"]')
  await expect(plan.getByText('Nothing pressing today.')).toBeVisible()

  // Keyboard-first: type, pick Today, a time, Enter.
  const capture = page.getByRole('region', { name: 'Quick capture' })
  const title = capture.getByRole('textbox', { name: 'Task', exact: true })
  await title.fill('Call the plumber')
  await capture.getByRole('button', { name: 'Today' }).click()
  await capture.getByLabel(/^Time/).fill('13:00')
  await title.press('Enter')
  await expect(capture.getByRole('status')).toHaveText('Added “Call the plumber”.')
  await expect(title).toHaveValue('')
  await expect(title).toBeFocused()

  const attention = page.locator('[data-home-module="needs-attention"]')
  const item = attention.locator('li', { hasText: 'Call the plumber' })
  await expect(item).toContainText('Due soon')
  await expect(item).toContainText('Due Today · 13:00')
  await expect(item.getByRole('link')).toHaveAttribute('href', /\/plan\/tasks\?task=[0-9a-f-]{36}$/)

  const today = page.locator('[data-home-module="today"]')
  await expect(today.getByTestId('today-tasks')).toContainText('Call the plumber')
  await expect(today.getByTestId('today-tasks')).toContainText('13:00')

  // The plan was drafted before the task existed: Home proposes a replan instead of changing it.
  await expect(plan.getByTestId('home-plan-changes')).toContainText('(1 new)')
  expect(sql(`select count(*) from public.plan_blocks`)).toBe('0')
  await plan.getByRole('button', { name: 'Replan remaining day' }).click()
  await expect(plan.getByTestId('todays-plan-card')).toContainText('Call the plumber')
  await expect(plan.getByTestId('todays-plan-card')).toContainText('Due today 13:00')
  await expect(plan.getByTestId('home-plan-changes')).toHaveCount(0)

  // Accept the block on Plan, and it persists.
  await plan.getByRole('link', { name: /Review and accept today/ }).click()
  await expect(page).toHaveURL(/\/plan$/)
  await page.getByRole('button', { name: 'Accept “Call the plumber”' }).click()
  const block = page.locator('[data-testid="plan-block"][data-title="Call the plumber"]')
  await expect(block).toHaveAttribute('data-state', 'accepted')
  await page.reload()
  await expect(block).toHaveAttribute('data-state', 'accepted')

  await page.goto('/')
  await expect(plan.getByTestId('todays-plan-card')).toContainText('Call the plumber')
  await page.reload()
  await expect(attention.locator('li', { hasText: 'Call the plumber' })).toBeVisible()
  expect(
    sql(
      `select b.state from public.plan_blocks b join public.tasks t on t.id = b.candidate_id
       where t.title = 'Call the plumber'`,
    ),
  ).toBe('accepted')
  expect(sql(`select source from public.tasks where title = 'Call the plumber'`)).toBe('manual')
})

test('check off a habit and a task from Today; both persist and can be undone', async ({
  page,
}) => {
  const zone = morningOwner()
  sql(`insert into public.habits (title, weekdays) values ('Stretch', '{1,2,3,4,5,6,7}')`)
  sql(`insert into public.tasks (title, due_date) values ('Water the plants', '${zone.today}')`)
  await signInAsOwner(page)
  const today = page.locator('[data-home-module="today"]')

  const habit = today.getByRole('checkbox', { name: /Stretch/ })
  await expect(habit).not.toBeChecked()
  await habit.check()
  await expect(habit).toBeChecked()
  await expect
    .poll(() =>
      sql(`select count(*) from public.habit_completions where local_date = '${zone.today}'`),
    )
    .toBe('1')

  const task = today.getByRole('checkbox', { name: 'Water the plants' })
  await task.check()
  await expect(task).toBeChecked()
  await expect.poll(() => sql(`select status from public.tasks`)).toBe('done')

  await page.reload()
  await expect(today.getByRole('checkbox', { name: /Stretch/ })).toBeChecked()
  await expect(today.getByRole('checkbox', { name: 'Water the plants' })).toBeChecked()

  await today.getByRole('checkbox', { name: /Stretch/ }).uncheck()
  await expect.poll(() => sql(`select count(*) from public.habit_completions`)).toBe('0')
  await today.getByRole('checkbox', { name: 'Water the plants' }).uncheck()
  await expect.poll(() => sql(`select status from public.tasks`)).toBe('open')
  await expect(today.getByRole('checkbox', { name: 'Water the plants' })).not.toBeChecked()
})

test('log reading from quick capture (keyboard to the Reading tab)', async ({ page }) => {
  const zone = morningOwner()
  sql(`insert into public.books (title, author, total_pages, status)
       values ('Deep Work', 'Cal Newport', 300, 'want')`)
  await signInAsOwner(page)
  const capture = page.getByRole('region', { name: 'Quick capture' })
  const taskTab = capture.getByRole('tab', { name: 'Task' })
  await expect(taskTab).toHaveAttribute('aria-selected', 'true')
  await taskTab.focus()
  await page.keyboard.press('ArrowRight')
  const readingTab = capture.getByRole('tab', { name: 'Reading' })
  await expect(readingTab).toHaveAttribute('aria-selected', 'true')
  await expect(readingTab).toBeFocused()

  await expect(capture.getByLabel('Book')).toHaveValue(/[0-9a-f-]{36}/)
  await capture.getByLabel('Page reached').fill('42')
  await capture.getByLabel(/^Minutes/).fill('20')
  await capture.getByRole('button', { name: 'Log reading' }).click()
  await expect(capture.getByRole('status')).toContainText(
    'Logged “Deep Work”: Page 42 of 300 · 14%. Marked as reading.',
  )
  expect(
    sql(
      `select l.page_reached || '|' || l.minutes || '|' || l.local_date || '|' || b.status
       from public.reading_logs l join public.books b on b.id = l.book_id`,
    ),
  ).toBe(`42|20|${zone.today}|reading`)

  // Percent works too; a page past the end is refused with the reason.
  await capture.getByRole('radio', { name: 'Percent', exact: true }).check()
  await capture.getByLabel('Percent through').fill('50')
  await capture.getByRole('button', { name: 'Log reading' }).click()
  await expect(capture.getByRole('status')).toContainText(/page 150 of 300 · 50%/i)
  await capture.getByRole('radio', { name: 'Page', exact: true }).check()
  await capture.getByLabel('Page reached').fill('400')
  await capture.getByRole('button', { name: 'Log reading' }).click()
  await expect(capture.getByRole('alert')).toContainText('past the end of this book')
  expect(sql(`select count(*) from public.reading_logs`)).toBe('2')
})

test('quick note saves through the notes area; journal and full note open their pages', async ({
  page,
}, info) => {
  morningOwner()
  const tag = `${info.project.name}-${Date.now().toString(36)}`
  await signInAsOwner(page)
  const capture = page.getByRole('region', { name: 'Quick capture' })
  await capture.getByRole('tab', { name: 'Note' }).click()
  await capture
    .getByRole('textbox', { name: 'Quick note' })
    .fill(`Ask about the boiler service ${tag}`)
  await capture.getByRole('textbox', { name: 'Quick note' }).press('Control+Enter')
  await expect(capture.getByRole('status')).toContainText('Note saved.')
  await expect(capture.getByRole('textbox', { name: 'Quick note' })).toHaveValue('')
  expect(
    sql(`select count(*) from public.notes where body = 'Ask about the boiler service ${tag}'`),
  ).toBe('1')
  await capture.getByRole('link', { name: 'Open note' }).click()
  await expect(page).toHaveURL(/\/capture\/notes\/[0-9a-f-]{36}$/)
  await expect(page.getByLabel('Note', { exact: true })).toHaveValue(
    `Ask about the boiler service ${tag}`,
  )

  await page.goto('/')
  await capture.getByRole('tab', { name: 'Note' }).click()
  await capture.getByRole('button', { name: 'New note' }).click()
  await expect(page).toHaveURL(/\/capture\/notes\/[0-9a-f-]{36}\?new=1$/)

  await page.goto('/')
  await capture.getByRole('tab', { name: 'Journal' }).click()
  await capture.getByRole('link', { name: 'Open today’s journal' }).click()
  await expect(page).toHaveURL(/\/capture\/journal$/)
  sql(`delete from public.notes where body like '%${tag}'`)
})

test('saved order is respected and a hidden module stays hidden', async ({ page }) => {
  morningOwner()
  const layout = JSON.stringify([
    { module: 'needs_attention', hidden: false },
    { module: 'todays_plan', hidden: false },
    { module: 'interests', hidden: false },
    { module: 'today', hidden: false },
    { module: 'briefing', hidden: true },
    { module: 'money_preview', hidden: false },
    { module: 'health_preview', hidden: true },
  ])
  sql(`update public.owner_settings set home_layout = '${layout}'::jsonb`)
  const expected = ['needs-attention', 'todays-plan', 'interests', 'today', 'money-preview']

  await signInAsOwner(page)
  expect(await moduleIds(page, 5)).toEqual(expected)
  await expect(page.getByRole('heading', { name: 'Latest briefing' })).toHaveCount(0)

  // A change on Home (which revalidates it) and a reload keep the layout.
  const capture = page.getByRole('region', { name: 'Quick capture' })
  await capture.getByRole('textbox', { name: 'Task', exact: true }).fill('Book the MOT')
  await capture.getByRole('button', { name: 'Add task' }).click()
  await expect(capture.getByRole('status')).toHaveText('Added “Book the MOT”.')
  expect(await moduleIds(page, 5)).toEqual(expected)
  await page.reload()
  expect(await moduleIds(page, 5)).toEqual(expected)
  await expect(page.getByRole('heading', { name: 'Health', exact: true })).toHaveCount(0)
})

test('labelled demo data: no horizontal scroll at 390px and 44px targets, then removed', async ({
  page,
}, info) => {
  morningOwner()
  // The seed script refuses production/Vercel environments: run it as local development does.
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      DATABASE_URL: `postgres://postgres@127.0.0.1:${process.env.PH_PG_PORT ?? '54329'}/${process.env.PH_E2E_DATABASE}`,
    }).filter(([key]) => !['NODE_ENV', 'VERCEL', 'VERCEL_ENV'].includes(key)),
  ) as NodeJS.ProcessEnv
  const seed = spawnSync(process.execPath, ['scripts/seed-demo.mjs'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  })
  expect(seed.status, seed.stderr).toBe(0)

  try {
    await signInAsOwner(page)
    await expect(page.getByTestId('demo-notice')).toContainText('Demo data')
    const attention = page.locator('[data-home-module="needs-attention"]')
    await expect(attention.getByTestId('attention-list')).toContainText('[demo]')
    await expect(
      page.locator('[data-home-module="today"]').getByTestId('today-habits'),
    ).toContainText('[demo] Morning stretch')

    const phone = (page.viewportSize()?.width ?? 1280) < 640
    if (phone) expect(page.viewportSize()?.width).toBe(390)
    for (const path of [
      '/',
      '/plan',
      '/plan/week',
      '/plan/tasks',
      '/plan/habits',
      '/learning',
      '/people',
      '/capture',
    ]) {
      await page.goto(path)
      await expectNoHorizontalScroll(page, `${info.project.name} ${path}`)
    }
    if (phone) {
      await page.goto('/')
      const small = await page
        .locator(
          '[data-home-module] a, [data-home-module] button, [data-home-module] input[type="checkbox"]',
        )
        .evaluateAll((els) =>
          els
            .filter((e) => (e as HTMLElement).offsetParent !== null)
            .map((e) => {
              // A checkbox's touch target is its label.
              const target = e.tagName === 'INPUT' ? (e.closest('label') ?? e) : e
              return {
                text: (e.textContent || e.getAttribute('aria-label') || '').trim(),
                h: target.getBoundingClientRect().height,
              }
            })
            .filter((x) => x.h < 44),
        )
      expect(small).toEqual([])
    }
  } finally {
    const removed = spawnSync(process.execPath, ['scripts/seed-demo.mjs', '--remove'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    })
    expect(removed.status, removed.stderr).toBe(0)
  }
  await page.goto('/')
  await expect(page.getByTestId('demo-notice')).toHaveCount(0)
  expect(sql(`select count(*) from public.tasks where title like '[demo]%'`)).toBe('0')
})
