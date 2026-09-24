/**
 * Learning: add a book, log progress by percentage and by page, and see honest progress.
 * Runs against the production build with the test-only sign-in (see playwright.config.ts).
 * Titles are unique per run because the e2e database is shared by every spec.
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

function uniqueTitle(prefix: string) {
  return `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

async function addBook(
  page: Page,
  title: string,
  options: { totalPages?: string; status?: string } = {},
) {
  const add = page.getByRole('form', { name: 'Add a book' })
  await add.getByLabel('Title').fill(title)
  if (options.totalPages) await add.getByLabel('Total pages').fill(options.totalPages)
  if (options.status) await add.getByLabel('Status').selectOption(options.status)
  await add.getByRole('button', { name: 'Add book' }).click()
  await expect(add.getByRole('status')).toHaveText(`Added “${title}”.`)
  // A successful save clears the form for the next book.
  await expect(add.getByLabel('Title')).toHaveValue('')
}

test.describe('Learning', () => {
  test('add a book, then log progress by percent and by page', async ({ page }) => {
    await signIn(page, '/learning')
    await expect(page.getByRole('heading', { level: 1, name: 'Learning' })).toBeVisible()

    const title = uniqueTitle('Middlemarch')
    await addBook(page, title, { totalPages: '320', status: 'reading' })

    const card = page.getByTestId('current-book').filter({ hasText: title })
    await expect(card.getByTestId('book-progress')).toHaveText('No progress logged yet')
    await expect(card.getByRole('progressbar')).toHaveCount(0)

    await card.locator('summary', { hasText: 'Log progress' }).click()
    const form = card.getByRole('form', { name: `Log progress for ${title}` })

    // By percentage: shown exactly as logged, converted to an approximate page.
    await form.getByRole('radio', { name: 'Percent' }).check()
    await form.getByLabel('Percent through').fill('25')
    await form.getByRole('button', { name: 'Log progress' }).click()
    await expect(form.getByRole('status')).toHaveText('Logged: About page 80 of 320 · 25%.')
    await expect(card.getByTestId('book-progress')).toHaveText('About page 80 of 320 · 25%')
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
    // The number box is cleared; the chosen measure stays.
    await expect(form.getByLabel('Percent through')).toHaveValue('')

    // By page reached.
    await form.getByRole('radio', { name: 'Page reached' }).check()
    await form.getByLabel('Page you reached').fill('120')
    await form.getByRole('button', { name: 'Log progress' }).click()
    await expect(card.getByTestId('book-progress')).toHaveText('Page 120 of 320 · 37.5%')
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '37')

    // A page past the end is refused (by the browser here; the server also checks), and
    // what was typed is kept.
    const pageBox = form.getByLabel('Page you reached')
    await pageBox.fill('400')
    await form.getByRole('button', { name: 'Log progress' }).click()
    expect(await pageBox.evaluate((el: HTMLInputElement) => el.validity.rangeOverflow)).toBe(true)
    await expect(pageBox).toHaveValue('400')
    await expect(card.getByTestId('book-progress')).toHaveText('Page 120 of 320 · 37.5%')

    // Both logs appear in the book's history.
    await card.getByRole('link', { name: title }).click()
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    const history = page.getByTestId('reading-history')
    await expect(history.getByRole('listitem')).toHaveCount(2)
    await expect(history).toContainText('Reached page 120')
    await expect(history).toContainText('25% through')
    await expectNoHorizontalScroll(page)
  })

  test('without total pages, a page is shown but no percentage is invented', async ({ page }) => {
    await signIn(page, '/learning')
    const title = uniqueTitle('No total')
    await addBook(page, title)

    // Want to read → logging on the book page starts it.
    await page.getByRole('link', { name: title }).click()
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    const form = page.getByRole('form', { name: `Log progress for ${title}` })
    await form.getByRole('radio', { name: 'Pages read' }).check()
    await form.getByLabel('Number of pages read').fill('30')
    await form.getByRole('button', { name: 'Log progress' }).click()
    await expect(form.getByRole('status')).toHaveText('Logged: 30 pages read. Marked as reading.')
    await expect(page.getByTestId('book-progress')).toHaveText('30 pages read')
    await expect(page.getByRole('progressbar')).toHaveCount(0)
    await expect(page.getByText('Add the total pages to see a percentage.')).toBeVisible()

    // Adding the total later makes the percentage derivable.
    const details = page.getByRole('form', { name: 'Edit book' })
    await details.getByLabel('Total pages').fill('300')
    await details.getByRole('button', { name: 'Save book' }).click()
    await expect(details.getByRole('status')).toHaveText('Saved.')
    await expect(page.getByTestId('book-progress')).toHaveText('30 pages read of 300 · 10%')
    // The edit form stays in step with what was stored.
    await expect(details.getByLabel('Total pages')).toHaveValue('300')
    await expect(details.getByLabel('Status')).toHaveValue('reading')
  })

  test('touch targets and layout hold at phone width', async ({ page }) => {
    await signIn(page, '/learning')
    await expectNoHorizontalScroll(page)
    const add = page.getByRole('form', { name: 'Add a book' })
    for (const control of [
      add.getByLabel('Title'),
      add.getByLabel('Status'),
      add.getByRole('button', { name: 'Add book' }),
    ]) {
      const box = await control.boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(page.viewportSize()!.width < 640 ? 44 : 40)
    }
  })
})
