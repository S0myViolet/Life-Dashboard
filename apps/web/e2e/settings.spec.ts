import { expect, test } from '@playwright/test'
import { localDateLabel, resetOwnerSettings, signInAsOwner, sql } from './helpers'

test.beforeEach(() => resetOwnerSettings())

test.describe('timezone confirmation', () => {
  test.use({ timezoneId: 'America/New_York' })

  test('the device timezone is only a suggestion until confirmed, then stays until changed', async ({
    page,
  }) => {
    await signInAsOwner(page)
    const banner = page.getByRole('region', { name: 'Confirm your timezone' })
    await expect(banner).toContainText('This device is set to America/New_York')
    await expect(banner).toContainText('Europe/London')
    await expect(page.getByTestId('home-date')).toHaveText(localDateLabel('Europe/London'))

    // Detecting it saved nothing.
    await page.reload()
    await expect(banner).toBeVisible()
    expect(sql('select timezone, timezone_confirmed from public.owner_settings')).toBe(
      'Europe/London|f',
    )

    await banner.getByRole('button', { name: 'Confirm America/New_York' }).click()
    await expect(banner).toBeHidden()
    expect(sql('select timezone, timezone_confirmed from public.owner_settings')).toBe(
      'America/New_York|t',
    )

    await page.reload()
    await expect(page.getByRole('region', { name: 'Confirm your timezone' })).toHaveCount(0)
    await expect(page.getByTestId('home-date')).toHaveText(localDateLabel('America/New_York'))
    await expect(page.getByRole('main')).toContainText('America/New_York')

    // Changing it in Settings is explicit and sticks across reloads.
    await page.goto('/settings/timezone')
    await expect(page.getByRole('heading', { name: 'America/New_York' })).toBeVisible()
    await expect(page.getByText('Confirmed', { exact: true })).toBeVisible()
    await page.getByLabel('Timezone', { exact: true }).selectOption('Asia/Tokyo')
    await page.getByRole('button', { name: 'Save timezone' }).click()
    await expect(page.getByText('Timezone set to Asia/Tokyo.')).toBeVisible()
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Asia/Tokyo' })).toBeVisible()
    // The device (New York) is offered but not applied.
    await expect(page.getByRole('button', { name: 'Use America/New_York' })).toBeVisible()

    await page.goto('/')
    await expect(page.getByTestId('home-date')).toHaveText(localDateLabel('Asia/Tokyo'))
  })

  test('the picker follows each save without a reload, so pressing Save again never reverts it', async ({
    page,
  }) => {
    await signInAsOwner(page, '/settings/timezone')
    const select = page.getByLabel('Timezone', { exact: true })
    const tz = () => sql('select timezone, timezone_confirmed from public.owner_settings')
    const saveResponse = () =>
      page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/settings'))
    await expect(select).toHaveValue('Europe/London')

    // Picker save: the heading and the select both show the new zone.
    await select.selectOption('Asia/Tokyo')
    await page.getByRole('button', { name: 'Confirm timezone' }).click()
    await expect(page.getByRole('heading', { name: 'Asia/Tokyo' })).toBeVisible()
    await expect(page.getByText('Timezone set to Asia/Tokyo.')).toBeVisible()
    await expect(select).toHaveValue('Asia/Tokyo')
    expect(tz()).toBe('Asia/Tokyo|t')

    // Device button: the select follows the saved zone too.
    await page.getByRole('button', { name: 'Use America/New_York' }).click()
    await expect(page.getByRole('heading', { name: 'America/New_York' })).toBeVisible()
    await expect(select).toHaveValue('America/New_York')
    expect(tz()).toBe('America/New_York|t')

    // Pressing Save without touching the picker keeps what was saved.
    const saved = saveResponse()
    await page.getByRole('button', { name: 'Save timezone' }).click()
    await saved
    await expect(page.getByRole('button', { name: 'Save timezone' })).toBeEnabled()
    await expect(page.getByRole('heading', { name: 'America/New_York' })).toBeVisible()
    await expect(select).toHaveValue('America/New_York')
    expect(tz()).toBe('America/New_York|t')
  })
})

test('confirming the default timezone in Settings keeps it and hides the Home banner', async ({
  page,
}) => {
  await signInAsOwner(page, '/settings/timezone')
  await expect(page.getByText('Not confirmed yet', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Timezone', { exact: true })).toHaveValue('Europe/London')
  await page.getByRole('button', { name: 'Confirm timezone' }).click()
  await expect(page.getByText('Timezone set to Europe/London.')).toBeVisible()
  expect(sql('select timezone, timezone_confirmed from public.owner_settings')).toBe(
    'Europe/London|t',
  )
  await page.reload()
  await expect(page.getByText('Confirmed', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save timezone' })).toBeVisible()
  await page.goto('/')
  await expect(page.getByTestId('home-date')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Confirm your timezone' })).toHaveCount(0)
})

test('home layout: hiding and reordering persist across reloads and shape Home', async ({
  page,
}) => {
  await signInAsOwner(page, '/settings/home-layout')
  const rows = page.locator('ol > li[data-module]')

  await page.getByRole('button', { name: 'Hide Health' }).click()
  await expect(page.getByRole('button', { name: 'Show Health' })).toBeVisible()
  await page.getByRole('button', { name: 'Move Latest briefing up' }).click()
  await expect(rows.nth(2)).toHaveAttribute('data-module', 'briefing')

  // Required modules are locked: they cannot be hidden or moved, and nothing moves above them.
  for (const name of ['Needs attention', 'Your plan for today']) {
    for (const action of ['Hide', 'Move'])
      await expect(
        page.getByRole('button', { name: new RegExp(`^${action} ${name}`) }),
      ).toHaveCount(0)
  }
  await expect(page.getByRole('button', { name: 'Move Latest briefing up' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Move Today up' })).toBeEnabled()

  await page.reload()
  await expect(rows).toHaveCount(7)
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-module')))).toEqual([
    'needs_attention',
    'todays_plan',
    'briefing',
    'today',
    'health_preview',
    'money_preview',
    'interests',
  ])
  await expect(rows.nth(4)).toHaveAttribute('data-hidden', 'true')

  await page.goto('/')
  // Visible modules only: a streamed module waits hidden (in arrival order) until React reveals it.
  const modules = page.locator('[data-home-module]:visible')
  await expect(modules).toHaveCount(6)
  expect(
    await modules.evaluateAll((els) => els.map((e) => e.getAttribute('data-home-module'))),
  ).toEqual(['needs-attention', 'todays-plan', 'briefing', 'today', 'money-preview', 'interests'])

  // Show it again and reset.
  await page.goto('/settings/home-layout')
  await page.getByRole('button', { name: 'Show Health' }).click()
  await expect(page.getByRole('button', { name: 'Hide Health' })).toBeVisible()
  await page.getByRole('button', { name: 'Reset Home layout to the default order' }).click()
  await expect(rows.nth(2)).toHaveAttribute('data-module', 'today')
})

test('available hours: overlaps are refused, valid hours are saved and used by Home', async ({
  page,
}) => {
  await signInAsOwner(page, '/settings/hours')
  await page.getByRole('button', { name: 'Add hours on Monday' }).click()
  await page.getByRole('button', { name: 'Add hours on Monday' }).click()
  await expect(page.getByLabel('Monday 1 from')).toHaveValue('09:00')
  await expect(page.getByLabel('Monday 2 from')).toHaveValue('17:00')
  await page.getByLabel('Monday 2 from').fill('16:00')
  await page.getByRole('button', { name: 'Save hours' }).click()
  await expect(page.getByText('Overlaps 09:00–17:00 on Monday')).toBeVisible()
  expect(sql('select available_hours is null from public.owner_settings')).toBe('t')

  await page.getByLabel('Monday 2 from').fill('17:30')
  await page.getByLabel('Monday 2 to').fill('18:30')
  await page.getByRole('button', { name: 'Save hours' }).click()
  await expect(page.getByText('Available hours saved.')).toBeVisible()

  await page.reload()
  await expect(page.getByLabel('Monday 2 from')).toHaveValue('17:30')
  await page.goto('/')
  await expect(page.locator('[data-home-module="todays-plan"]')).toContainText(
    'Mon 09:00–17:00, 17:30–18:30',
  )

  // Clearing returns to "not set", and Home says so honestly.
  await page.goto('/settings/hours')
  await page.getByRole('button', { name: 'Clear all' }).click()
  await page.getByRole('button', { name: 'Save hours' }).click()
  await expect(page.getByText('Available hours cleared.')).toBeVisible()
  await page.goto('/')
  await expect(page.locator('[data-home-module="todays-plan"]')).toContainText(
    'No available hours are set',
  )
})

test('settings links to connections and the Chrome helper, and shows honest placeholders', async ({
  page,
}) => {
  await signInAsOwner(page, '/settings')
  await expect(page.getByRole('link', { name: /Connected accounts/ })).toHaveAttribute(
    'href',
    '/settings/connections',
  )
  await expect(page.getByRole('link', { name: /Chrome helper/ })).toHaveAttribute(
    'href',
    '/settings/chrome-helper',
  )
  await page.getByRole('link', { name: /Data retention/ }).click()
  await expect(page.getByText('Deleted after 30 days.')).toBeVisible()
  await expect(page.getByText('not running yet')).toBeVisible()
  await page.goto('/settings/notifications')
  await expect(page.getByText('Planned · Milestone 2')).toBeVisible()
  await page.goto('/settings/budget')
  await expect(page.getByRole('row', { name: /AI and transcription/ })).toContainText('£15')
  await page.goto('/settings/install')
  await expect(page.getByRole('heading', { name: 'On iPhone', exact: true })).toBeVisible()
  await expect(page.getByText('Add to Home Screen', { exact: true })).toBeVisible()
})
