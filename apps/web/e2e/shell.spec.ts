import { expect, test } from '@playwright/test'
import { resetOwnerSettings, signInAsOwner } from './helpers'

test.beforeEach(async ({ page }) => {
  resetOwnerSettings()
  await signInAsOwner(page)
  await expect(page).toHaveURL(/\/$/)
})

test('iPhone width shows the five-item bottom navigation and no sidebar', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'iphone', 'phone layout')
  expect(page.viewportSize()?.width).toBe(390)
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav).toHaveCount(1)
  await expect(nav.getByRole('link')).toHaveText(['Home', 'Plan', 'Capture', 'Updates', 'More'])
  await expect(page.locator('aside')).toBeHidden()

  // Touch targets are at least 44px tall.
  for (const box of await nav
    .getByRole('link')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) {
    expect(box).toBeGreaterThanOrEqual(44)
  }
  // No sideways scrolling at phone width, on Home or Settings.
  for (const path of ['/', '/settings', '/settings/hours', '/settings/home-layout']) {
    await page.goto(path)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow, path).toBeLessThanOrEqual(0)
  }
})

test('desktop shows the compact sidebar and no bottom navigation', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop layout')
  await expect(page.locator('aside')).toBeVisible()
  const nav = page.getByRole('navigation', { name: 'Main' })
  await expect(nav).toHaveCount(1)
  await expect(nav.getByRole('link')).toHaveText([
    'Home',
    'Plan',
    'Projects',
    'Capture',
    'Updates',
    'Money',
    'Health',
    'Learning',
    'People',
    'Settings',
  ])
  await expect(page.locator('nav.fixed')).toBeHidden()
})

test('More lists Projects, Money, Health, Learning, People and Settings', async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === 'iphone') {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'More' }).click()
    await expect(page).toHaveURL(/\/more$/)
  } else {
    await page.goto('/more')
  }
  await expect(page.getByRole('main').getByRole('link')).toHaveText([
    'Projects',
    'Money',
    'Health',
    'Learning',
    'People',
    'Settings',
  ])
  await page.getByRole('main').getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
})

test('skip link and keyboard focus work', async ({ page }) => {
  await page.keyboard.press('Tab')
  const skip = page.getByRole('link', { name: 'Skip to content' })
  await expect(skip).toBeFocused()
  await expect(skip).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#main$/)

  // The next Tab lands inside <main>, with a visible focus ring.
  await page.keyboard.press('Tab')
  const focus = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    const style = el ? getComputedStyle(el) : null
    return {
      inMain: Boolean(el?.closest('#main')),
      outline: style?.outlineStyle,
      width: style?.outlineWidth,
    }
  })
  expect(focus.inMain).toBe(true)
  expect(focus.outline).toBe('solid')
  expect(focus.width).toBe('2px')

  // Keyboard-only: reach Settings → Home layout and operate a control with Enter.
  await page.goto('/settings/home-layout')
  const moveDown = page.getByRole('button', { name: 'Move Needs attention down' })
  await moveDown.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('ol > li[data-module]').first()).toHaveAttribute(
    'data-module',
    'todays_plan',
  )
})
