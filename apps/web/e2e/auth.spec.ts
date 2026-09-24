import { expect, test } from '@playwright/test'
import {
  e2eSessionCookie,
  localDateLabel,
  owner,
  resetOwnerSettings,
  setSessionCookie,
  signInAsOwner,
  stranger,
} from './helpers'

test.beforeEach(() => resetOwnerSettings())

test('signed-out visitors are sent to /login, keeping the page they asked for', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/login\?next=%2F$/)
  await expect(page.getByRole('heading', { name: 'Personal Home' })).toBeVisible()

  await page.goto('/settings/timezone')
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Ftimezone$/)
})

test('test sign-in opens Home with a greeting and the date in the owner timezone', async ({
  page,
}) => {
  await signInAsOwner(page)
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    /^(Good morning|Good afternoon|Good evening|Hello)$/,
  )
  // The owner's saved timezone (default Europe/London), not the browser's or the server's.
  await expect(page.getByTestId('home-date')).toHaveText(localDateLabel('Europe/London'))
  await expect(page.getByRole('main')).toContainText('Europe/London')

  // Every module renders an honest state; nothing claims the owner is all caught up.
  for (const title of [
    'Needs attention',
    'Your plan for today',
    'Today',
    'Latest briefing',
    'Health',
    'Money',
    'Interests',
    'Quick capture',
  ]) {
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  }
  const text = await page.getByRole('main').innerText()
  expect(text).not.toMatch(/nothing needs attention|you'?re all caught up|no events today/i)
  // Needs attention names the sources that are not connected yet instead of claiming all clear.
  expect(text).toMatch(/Deadlines from email and calendars are not connected yet \(Milestone 2\)/)
})

test('a signed-in non-owner is sent to /not-authorized and sees no owner data', async ({
  page,
  context,
  baseURL,
}) => {
  await setSessionCookie(
    context,
    baseURL!,
    e2eSessionCookie({ sub: stranger.id, email: stranger.email }),
  )
  for (const path of ['/', '/settings', '/settings/timezone', '/settings/home-layout', '/more']) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/not-authorized$/)
    await expect(page.getByRole('heading', { name: 'This home is private' })).toBeVisible()
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0)
    const body = await page.locator('body').innerText()
    expect(body).not.toContain(owner.email)
    expect(body).not.toContain('Europe/London')
    expect(body).not.toMatch(/Good (morning|afternoon|evening)/)
  }
})

test('forged or tampered session cookies are rejected', async ({ page, context, baseURL }) => {
  // The owner's identity, signed with the wrong secret.
  await setSessionCookie(
    context,
    baseURL!,
    e2eSessionCookie({ sub: owner.id, email: owner.email }, 'not-the-server-secret-'.repeat(3)),
  )
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)

  // A valid stranger signature with the payload swapped for the owner's.
  const genuine = e2eSessionCookie({ sub: stranger.id, email: stranger.email })
  const [, mac] = genuine.split('.')
  const ownerPayload = Buffer.from(JSON.stringify({ sub: owner.id, email: owner.email })).toString(
    'base64url',
  )
  await context.clearCookies()
  await setSessionCookie(context, baseURL!, `${ownerPayload}.${mac}`)
  await page.goto('/settings')
  await expect(page).toHaveURL(/\/login/)

  // Garbage.
  await context.clearCookies()
  await setSessionCookie(context, baseURL!, 'not-a-session')
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)
})

test('signing out ends the session', async ({ page }) => {
  await signInAsOwner(page, '/settings')
  await page.getByRole('main').getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/signed-out$/)
  await expect(page.getByRole('heading', { name: 'Signed out' })).toBeVisible()
  await page.goto('/')
  await expect(page).toHaveURL(/\/login/)
})
