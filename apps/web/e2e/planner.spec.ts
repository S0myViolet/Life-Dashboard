/**
 * Daily planner flows against a production build with the test-only sign-in.
 * Runs under playwright.config.ts (its global setup seeds the owner and exports
 * PH_E2E_DATABASE / PH_E2E_AUTH_SECRET). All data is synthetic.
 *
 * The owner's timezone is set to a fixed-offset zone where it is late morning when the test
 * runs, so "no block before now" and "fits today" hold at any wall-clock time.
 */
import { spawnSync } from 'node:child_process'
import { expect, test, type Locator, type Page } from '@playwright/test'

function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set; run through playwright.config.ts (global setup)`)
  return value
}

function sql(query: string): string {
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
      env('PH_E2E_DATABASE'),
      '-c',
      query,
    ],
    { encoding: 'utf8' },
  )
  if (res.status !== 0) throw new Error(`psql failed: ${res.stderr}`)
  return res.stdout.trim()
}

/** A fixed-offset IANA zone (Etc/GMT±N) in which it is currently about 10:00. */
function lateMorningZone(): { tz: string; today: string; yesterday: string } {
  const now = new Date()
  let offset = 10 - now.getUTCHours()
  if (offset > 14) offset -= 24
  if (offset < -12) offset += 24
  // Etc/GMT signs are inverted: Etc/GMT-3 is UTC+3.
  const tz = offset === 0 ? 'Etc/UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`
  const local = (ms: number) => new Date(ms + offset * 3_600_000).toISOString().slice(0, 10)
  return { tz, today: local(now.getTime()), yesterday: local(now.getTime() - 86_400_000) }
}

let zone: ReturnType<typeof lateMorningZone>

const ALL_DAY = JSON.stringify(
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '00:00', end: '24:00' })),
)

function reset(availableHours: string | null = ALL_DAY) {
  zone = lateMorningZone()
  sql(`delete from public.daily_plans; delete from public.tasks; delete from public.habits;`)
  sql(
    `update public.owner_settings set timezone = '${zone.tz}', timezone_confirmed = true,
       available_hours = ${availableHours ? `'${availableHours}'::jsonb` : 'null'}`,
  )
}

let createdSeq = 0
function addTask(fields: {
  title: string
  priority?: number
  dueDate?: string
  dueAtLocal?: string
  minutes?: number
  confirmed?: boolean
  source?: string
}) {
  createdSeq++
  const dueAt = fields.dueAtLocal
    ? `(timestamp '${zone.today} ${fields.dueAtLocal}' at time zone '${zone.tz}')`
    : 'null'
  const dueDate = fields.dueAtLocal
    ? `'${zone.today}'`
    : fields.dueDate
      ? `'${fields.dueDate}'`
      : 'null'
  sql(
    `insert into public.tasks (title, priority, due_date, due_at, duration_minutes, confirmed, source, created_at)
     values ('${fields.title.replace(/'/g, "''")}', ${fields.priority ?? 'null'}, ${dueDate}, ${dueAt},
             ${fields.minutes ?? 'null'}, ${fields.confirmed ?? true}, '${fields.source ?? 'manual'}',
             now() - interval '${100 - createdSeq} minutes')`,
  )
}

async function signIn(page: Page, next = '/plan') {
  await page.goto(`/api/test/login?next=${encodeURIComponent(next)}`)
}

const block = (page: Page, title: string): Locator =>
  page.locator(`[data-testid="plan-block"][data-title="${title}"]`)

async function timelineTitles(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="plan-timeline"] [data-testid="plan-block"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-title') ?? ''))
}

async function expectNothingBefore(page: Page, since: number) {
  const starts = await page
    .locator('[data-testid="plan-block"][data-state="suggested"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-start') ?? ''))
  for (const s of starts.filter(Boolean)) expect(Date.parse(s)).toBeGreaterThanOrEqual(since - 1000)
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

test.beforeEach(() => reset())

// Leave the shared e2e database as other specs expect it (first-run owner settings, no plan data).
test.afterAll(() => {
  sql(`delete from public.daily_plans; delete from public.tasks; delete from public.habits;`)
  sql(
    `update public.owner_settings set timezone = 'Europe/London', timezone_confirmed = false,
       available_hours = null`,
  )
})

test('first visit drafts today’s plan with priorities, reasons and nothing in the past', async ({
  page,
}) => {
  addTask({ title: 'Overdue report', dueDate: zone.yesterday, minutes: 60 })
  addTask({ title: 'Call the bank', dueAtLocal: '20:00' })
  addTask({ title: 'Plan holiday', priority: 1, minutes: 45 })
  addTask({ title: 'Tidy desk', minutes: 10 })
  addTask({ title: 'Reply to Sam', confirmed: false, source: 'email_suggestion' })
  expect(sql(`select count(*) from public.daily_plans`)).toBe('0')

  const before = Date.now()
  await signIn(page)
  await expect(page.getByRole('heading', { name: 'Plan', level: 1 })).toBeVisible()

  const priorities = page.getByTestId('plan-priorities')
  await expect(priorities.getByText('Overdue report')).toBeVisible()
  await expect(priorities.getByText(/^Overdue since /)).toBeVisible()
  await expect(priorities.getByText('Due today 20:00')).toBeVisible()
  await expect(priorities.getByText('Marked high priority')).toBeVisible()
  await expect(priorities.locator('li')).toHaveCount(3)

  // Suggested blocks, labelled estimates, a small task and a tentative suggestion.
  await expect(block(page, 'Call the bank')).toContainText('Estimate · 30 min')
  await expect(page.getByTestId('plan-small').getByText('Tidy desk')).toBeVisible()
  await expect(block(page, 'Reply to Sam')).toContainText('Tentative')
  await expectNothingBefore(page, before)

  expect(
    sql(
      `select count(*) from public.daily_plans where local_date = '${zone.today}' and source = 'auto_first_use'`,
    ),
  ).toBe('1')

  // Loading again does not create another plan.
  await page.reload()
  await expect(block(page, 'Overdue report')).toBeVisible()
  expect(sql(`select count(*) from public.daily_plans`)).toBe('1')

  await expectNoHorizontalScroll(page)
  const accept = page.getByRole('button', { name: 'Accept “Plan holiday”' })
  const box = await accept.boundingBox()
  if ((page.viewportSize()?.width ?? 1280) < 640) expect(box!.height).toBeGreaterThanOrEqual(44)
})

test('accept and edit survive a reload', async ({ page }) => {
  addTask({ title: 'Write intro', priority: 1, minutes: 30 })
  addTask({ title: 'Review notes', priority: 1, minutes: 30 })
  await signIn(page)

  await page.getByRole('button', { name: 'Accept “Write intro”' }).click()
  await expect(block(page, 'Write intro')).toHaveAttribute('data-state', 'accepted')

  const review = block(page, 'Review notes')
  await review.getByText('Edit time or duration').click()
  await review.getByLabel('Minutes').fill('50')
  await review.getByRole('button', { name: 'Save' }).click()
  await expect(review).toContainText('50 min')

  await page.reload()
  await expect(block(page, 'Write intro')).toHaveAttribute('data-state', 'accepted')
  await expect(block(page, 'Review notes')).toContainText('50 min')
  expect(
    sql(
      `select edited_by_owner, minutes from public.plan_blocks where title_snapshot = 'Review notes'`,
    ),
  ).toBe('t|50')
})

test('replan keeps accepted and pinned blocks and adds new work after now', async ({ page }) => {
  addTask({ title: 'Alpha', priority: 1, minutes: 30 })
  addTask({ title: 'Bravo', priority: 1, minutes: 30 })
  addTask({ title: 'Charlie', priority: 1, minutes: 30 })
  await signIn(page)

  await page.getByRole('button', { name: 'Accept “Alpha”' }).click()
  await expect(block(page, 'Alpha')).toHaveAttribute('data-state', 'accepted')
  await page.getByRole('button', { name: 'Pin “Bravo”' }).click()
  await expect(block(page, 'Bravo')).toHaveAttribute('data-state', 'pinned')
  const alphaStart = await block(page, 'Alpha').getAttribute('data-start')
  const bravoStart = await block(page, 'Bravo').getAttribute('data-start')

  addTask({ title: 'Urgent fix', dueDate: zone.today, minutes: 30 })
  await page.reload()
  await expect(page.getByTestId('plan-changes')).toContainText('1 new')

  const before = Date.now()
  await page.getByRole('button', { name: 'Replan remaining day' }).click()
  await expect(page.getByText(/^Replanned: /)).toBeVisible()
  await expect(block(page, 'Urgent fix')).toBeVisible()

  await expect(block(page, 'Alpha')).toHaveAttribute('data-state', 'accepted')
  await expect(block(page, 'Alpha')).toHaveAttribute('data-start', alphaStart!)
  await expect(block(page, 'Bravo')).toHaveAttribute('data-state', 'pinned')
  await expect(block(page, 'Bravo')).toHaveAttribute('data-start', bravoStart!)
  await expect(block(page, 'Charlie')).toBeVisible()
  await expect(page.getByTestId('plan-changes')).toHaveCount(0)
  await expectNothingBefore(page, before)
  expect(sql(`select source from public.daily_plans`)).toBe('replan')
})

test('keyboard reorder moves a block and keeps focus on the control', async ({ page }) => {
  addTask({ title: 'Xray', priority: 2, minutes: 30 })
  addTask({ title: 'Yankee', priority: 2, minutes: 30 })
  addTask({ title: 'Zulu', priority: 2, minutes: 30 })
  await signIn(page)
  await expect.poll(() => timelineTitles(page)).toEqual(['Xray', 'Yankee', 'Zulu'])

  const later = page.getByRole('button', { name: 'Move “Xray” later' })
  await later.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => timelineTitles(page)).toEqual(['Yankee', 'Xray', 'Zulu'])
  await expect(later).toBeFocused()

  await page.keyboard.press('Enter')
  await expect.poll(() => timelineTitles(page)).toEqual(['Yankee', 'Zulu', 'Xray'])
  await expect(page.getByRole('button', { name: 'Move “Xray” later' })).toBeDisabled()

  await page.reload()
  await expect.poll(() => timelineTitles(page)).toEqual(['Yankee', 'Zulu', 'Xray'])
})

test('without available hours the plan is an ordered list with no invented times', async ({
  page,
}) => {
  reset(null)
  addTask({ title: 'First thing', dueDate: zone.today })
  addTask({ title: 'Second thing', minutes: 45 })
  await signIn(page)
  const list = page.getByTestId('plan-list')
  await expect(list.locator('[data-testid="plan-block"]')).toHaveCount(2)
  expect(
    await list
      .locator('[data-testid="plan-block"]')
      .evaluateAll((els) =>
        els.map((e) => [e.getAttribute('data-title'), e.getAttribute('data-start')]),
      ),
  ).toEqual([
    ['First thing', ''],
    ['Second thing', ''],
  ])
  await expect(page.getByText('Estimate · 30 min')).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'Set available hours in Settings' }).first(),
  ).toBeVisible()
  await expect(page.getByTestId('plan-timeline')).toHaveCount(0)
  await expectNoHorizontalScroll(page)
})

test('week view shows seven days and opens today', async ({ page }) => {
  addTask({ title: 'Due today', dueDate: zone.today })
  await signIn(page, '/plan/week')
  const days = page.getByTestId('plan-week').locator('li')
  await expect(days).toHaveCount(7)
  const today = page.getByTestId('plan-week').locator('a[aria-current="date"]')
  await expect(today).toContainText('1 task due')
  await expect(today).toContainText('Calendar not connected')
  await expectNoHorizontalScroll(page)
  await today.click()
  await expect(page).toHaveURL(/\/plan$/)
  await expect(block(page, 'Due today')).toBeVisible()
})
