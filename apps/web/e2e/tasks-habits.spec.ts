/**
 * Plan › Habits end to end: create a habit, check it off for today (optimistic
 * toggle), history that survives reloads and shows missed days honestly,
 * editing weekdays, and the 390px phone layout.
 */
import { spawnSync } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

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

test.beforeEach(() => {
  test.skip(minutesToLondonMidnight() < 3, 'Too close to midnight in London for date assertions')
  sql(`delete from public.habits; update public.owner_settings set timezone = '${TZ}';`)
})

test('check off a habit for today; history persists and shows missed days', async ({ page }) => {
  const today = londonDate(0)
  await signIn(page, '/plan/habits')
  await expect(page.getByRole('heading', { level: 1, name: 'Habits' })).toBeVisible()
  await expect(page.getByText('No habits yet')).toBeVisible()

  await page.getByLabel('New habit').fill('Stretch')
  // Every day is selected by default, so the habit is due today whatever the weekday.
  for (const day of ['Monday', 'Sunday']) {
    await expect(page.getByRole('checkbox', { name: day })).toBeChecked()
  }
  await page.getByRole('button', { name: 'Add habit' }).click()
  await expect(page.getByText('Added “Stretch”.')).toBeVisible()

  const todayCard = page.getByRole('region', { name: /^Today/ })
  const toggle = todayCard.getByRole('button', { name: 'Stretch', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => sql('select local_date from public.habit_completions')).toBe(today)

  const card = page.getByRole('article', { name: 'Stretch' })
  await expect(card.locator(`td[data-date="${today}"]`)).toHaveAttribute('data-state', 'done')
  await expect(card.locator(`td[data-date="${today}"]`)).toContainText(': done')

  // Backdate the habit and add an older completion: the gap shows as missed.
  sql(`update public.habits set created_at = now() - interval '10 days';
       insert into public.habit_completions (habit_id, local_date)
       select id, '${londonDate(-3)}' from public.habits`)
  await page.reload()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(card.locator(`td[data-date="${londonDate(-3)}"]`)).toHaveAttribute(
    'data-state',
    'done',
  )
  for (const offset of [-2, -1]) {
    const cell = card.locator(`td[data-date="${londonDate(offset)}"]`)
    await expect(cell).toHaveAttribute('data-state', 'missed')
    await expect(cell).toContainText(': missed')
  }
  await expect(card).toContainText('Streak: 1')
  await expect(card).toContainText('2 of 11 scheduled days done, 9 missed')
  await expect(card.locator(`td[data-date="${londonDate(1)}"]`)).toHaveCount(
    // Tomorrow is in the grid only when today is not a Sunday.
    new Date(`${today}T12:00:00Z`).getUTCDay() === 0 ? 0 : 1,
  )

  // Un-check today; it stays un-checked after a reload.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(() => sql(`select count(*) from public.habit_completions where local_date = '${today}'`))
    .toBe('0')
  await page.reload()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(card.locator(`td[data-date="${today}"]`)).toHaveAttribute('data-state', 'pending')
})

test('edit weekdays, archive and restore a habit', async ({ page }) => {
  await signIn(page, '/plan/habits')
  await page.getByLabel('New habit').fill('Gym')
  await page.getByRole('button', { name: 'Add habit' }).click()
  await expect(page.getByText('Added “Gym”.')).toBeVisible()

  const card = page.getByRole('article', { name: 'Gym' })
  await card.getByRole('button', { name: 'Edit Gym' }).click()
  const sheet = page.getByRole('dialog', { name: 'Edit habit' })
  for (const day of ['Tuesday', 'Thursday', 'Saturday', 'Sunday']) {
    await sheet.getByRole('checkbox', { name: day }).uncheck()
  }
  await sheet.getByRole('button', { name: 'Save changes' }).click()
  await expect(sheet).toBeHidden()
  await expect(card).toContainText('Mon, Wed, Fri')
  expect(sql('select weekdays from public.habits')).toBe('{1,3,5}')

  // Refuses an empty selection with an inline error.
  await card.getByRole('button', { name: 'Edit Gym' }).click()
  for (const day of ['Monday', 'Wednesday', 'Friday']) {
    await sheet.getByRole('checkbox', { name: day }).uncheck()
  }
  await sheet.getByRole('button', { name: 'Save changes' }).click()
  await expect(sheet.getByText('Pick at least one day')).toBeVisible()
  expect(sql('select weekdays from public.habits')).toBe('{1,3,5}')

  await sheet.getByRole('button', { name: 'Archive habit' }).click()
  await expect(sheet).toBeHidden()
  await expect(page.getByRole('article', { name: 'Gym' })).toHaveCount(0)
  await page.getByText('Archived (1)').click()
  await page.getByRole('button', { name: 'Restore Gym' }).click()
  await expect(page.getByRole('article', { name: 'Gym' })).toBeVisible()
  expect(sql('select active from public.habits')).toBe('t')
})

test.describe('on a 390px phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the habits screen fits and its targets are 44px', async ({ page }) => {
    await signIn(page, '/plan/habits')
    await page.getByLabel('New habit').fill('Walk')
    await page.getByRole('button', { name: 'Add habit' }).tap()
    await expect(page.getByText('Added “Walk”.')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

    const toggle = page
      .getByRole('region', { name: /^Today/ })
      .getByRole('button', { name: 'Walk', exact: true })
    const toggleBox = await toggle.boundingBox()
    expect(toggleBox!.height).toBeGreaterThanOrEqual(44)
    await toggle.tap()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')

    // Weekday chips: the whole chip is the checkbox's label.
    for (const day of ['Monday', 'Sunday']) {
      const chip = page
        .getByRole('region', { name: 'Add a habit' })
        .locator('label')
        .filter({ has: page.getByRole('checkbox', { name: day }) })
      const box = await chip.boundingBox()
      expect(box!.height).toBeGreaterThanOrEqual(44)
      expect(box!.width).toBeGreaterThanOrEqual(44)
    }
    // The history grid fits inside its card.
    const grid = page.getByRole('article', { name: 'Walk' }).getByRole('table')
    const gridBox = await grid.boundingBox()
    expect(gridBox!.x + gridBox!.width).toBeLessThanOrEqual(390)
  })
})
