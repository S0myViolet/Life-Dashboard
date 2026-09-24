/**
 * People: add a person with a birthday (29 February) and a catch-up cadence, mark
 * caught up, add another date, and search. Runs against the production build with the
 * test-only sign-in (see playwright.config.ts). Names are unique per run.
 */
import { expect, test, type Page } from '@playwright/test'

async function signIn(page: Page, next: string) {
  await page.goto(`/api/test/login?next=${encodeURIComponent(next)}`)
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

function uniqueName(prefix: string) {
  return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

/** Whether the next 29 February birthday (from today in the owner's default zone) falls in a common year. */
function nextLeapBirthdayIsObservedOn28th(timeZone = 'Europe/London'): boolean {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone })
    .format(new Date())
    .split('-')
    .map(Number) as [number, number, number]
  const observedDay = isLeap(y) ? 29 : 28
  const passed = m > 2 || (m === 2 && d > observedDay)
  return !isLeap(passed ? y + 1 : y)
}

test.describe('People', () => {
  test('add a person with a birthday and a cadence, then mark caught up', async ({ page }) => {
    await signIn(page, '/people')
    await expect(page.getByRole('heading', { level: 1, name: 'People' })).toBeVisible()
    await expectNoHorizontalScroll(page)

    const name = uniqueName('Leap Cousin')
    const form = page.getByRole('form', { name: 'Add a person' })
    await form.getByLabel('Name').fill(name)
    await form.getByLabel('Relationship').fill('cousin in Leeds')
    await form.getByLabel('Month').selectOption({ label: 'February' })
    await form.getByLabel('Day').selectOption('29')
    await form.getByLabel('Remind me to catch up').selectOption({ label: 'Every 2 weeks' })
    await form.getByLabel('Notes').fill('Ask about the new job.\nLikes climbing.')
    await form.getByRole('button', { name: 'Add person' }).click()

    // Saved, and taken to their page.
    await expect(page).toHaveURL(/\/people\/[0-9a-f-]{36}$/)
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
    await expect(page.getByText('cousin in Leeds').first()).toBeVisible()
    await expect(page.getByTestId('person-notes')).toHaveText(
      'Ask about the new job.\nLikes climbing.',
    )

    const dates = page.getByTestId('important-dates')
    await expect(dates).toContainText('Birthday · 29 February')
    if (nextLeapBirthdayIsObservedOn28th()) {
      await expect(dates).toContainText('marked on 28 Feb — no 29 Feb this year')
    } else {
      await expect(dates).not.toContainText('marked on 28 Feb')
    }

    // The cadence counts from today: nothing due yet, nothing recorded yet.
    await expect(page.getByTestId('catch-up-status')).toContainText('Next catch-up in 14 days')
    await expect(page.getByTestId('last-caught-up')).toHaveText('No catch-up recorded yet')

    await page.getByRole('button', { name: 'Caught up today' }).click()
    await expect(page.getByTestId('last-caught-up')).toHaveText('Last caught up today')
    await expect(page.getByTestId('catch-up-status')).toContainText('Next catch-up in 14 days')
    // The edit form reflects the stored date.
    await expect(
      page.getByRole('form', { name: 'Edit person' }).getByLabel('Last caught up'),
    ).not.toHaveValue('')

    // Another important date, with a year.
    await page.locator('summary', { hasText: 'Add a date' }).click()
    const dateForm = page.getByRole('form', { name: 'Add an important date' })
    await dateForm.getByLabel('What is it?').fill('Anniversary')
    await dateForm.getByLabel('Month').selectOption({ label: 'June' })
    await dateForm.getByLabel('Day').selectOption('12')
    await dateForm.getByLabel('Year (optional)').fill('2015')
    await dateForm.getByRole('button', { name: 'Add date' }).click()
    await expect(dateForm.getByRole('status')).toHaveText('Added anniversary.')
    await expect(dates).toContainText('Anniversary · 12 June 2015')
    await expect(dates.getByRole('listitem')).toHaveCount(2)

    // 29 February with a common year is refused, and the form keeps what was typed.
    await dateForm.getByLabel('What is it?').fill('Wedding')
    await dateForm.getByLabel('Month').selectOption({ label: 'February' })
    await dateForm.getByLabel('Day').selectOption('29')
    await dateForm.getByLabel('Year (optional)').fill('2023')
    await dateForm.getByRole('button', { name: 'Add date' }).click()
    await expect(dateForm).toContainText('2023 has no 29 February')
    await expect(dateForm.getByLabel('Year (optional)')).toHaveValue('2023')
    await expect(dates.getByRole('listitem')).toHaveCount(2)
    await expectNoHorizontalScroll(page)

    // Search finds them by relationship text, case-insensitively.
    await page.goto('/people')
    await page.getByRole('searchbox', { name: 'Search people' }).fill('COUSIN IN LEEDS')
    await page.getByRole('button', { name: 'Search' }).click()
    await expect(page).toHaveURL(/\?q=COUSIN/)
    const results = page.getByRole('region', { name: /^Matching/ })
    await expect(results.getByRole('link', { name })).toBeVisible()
    await page.getByRole('searchbox', { name: 'Search people' }).fill('no such person zz')
    await page.getByRole('button', { name: 'Search' }).click()
    await expect(page.getByText('No one matches')).toBeVisible()
  })

  test('deleting a person asks first, then returns to the list', async ({ page }) => {
    await signIn(page, '/people')
    const name = uniqueName('Temporary')
    const form = page.getByRole('form', { name: 'Add a person' })
    await form.getByLabel('Name').fill(name)
    await form.getByRole('button', { name: 'Add person' }).click()
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
    await page.getByRole('button', { name: 'Delete person' }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page).toHaveURL(/\/people$/)
    await expect(page.getByRole('link', { name })).toHaveCount(0)
  })

  test('a due catch-up shows under Coming up and clears when caught up', async ({ page }) => {
    await signIn(page, '/people')
    const name = uniqueName('Old Friend')
    const form = page.getByRole('form', { name: 'Add a person' })
    await form.getByLabel('Name').fill(name)
    await form.getByLabel('Remind me to catch up').selectOption({ label: 'Every week' })
    await form.getByRole('button', { name: 'Add person' }).click()
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()

    // Record an old catch-up so one is overdue now.
    const edit = page.getByRole('form', { name: 'Edit person' })
    const past = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
    await edit.getByLabel('Last caught up').fill(past)
    await edit.getByRole('button', { name: 'Save' }).click()
    await expect(edit.getByRole('status')).toHaveText('Saved.')
    await expect(page.getByTestId('catch-up-status')).toContainText('Catch-up overdue by')

    await page.goto('/people')
    const comingUp = page.getByRole('region', { name: 'Coming up' })
    await expect(comingUp.getByRole('link', { name })).toBeVisible()

    await comingUp.getByRole('link', { name }).click()
    await page.getByRole('button', { name: 'Caught up today' }).click()
    await expect(page.getByTestId('last-caught-up')).toHaveText('Last caught up today')
    await page.goto('/people')
    await expect(
      page.getByRole('region', { name: 'Coming up' }).getByRole('link', { name }),
    ).toHaveCount(0)
  })
})
