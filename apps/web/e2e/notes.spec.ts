/**
 * Notes flows under the Playwright harness in playwright.config.ts (test-only sign-in, seeded
 * owner, PH_E2E_DATABASE). Titles carry a per-run suffix because the desktop and iPhone projects
 * share one database.
 */
import { spawnSync } from 'node:child_process'
import { expect, test, type Page, type Route } from '@playwright/test'

function sql(query: string): string {
  const db = process.env.PH_E2E_DATABASE
  if (!db) throw new Error('PH_E2E_DATABASE is not set; run through playwright.config.ts')
  const res = spawnSync(
    'psql',
    ['-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', process.env.PH_PG_PORT ?? '54329', '-U', 'postgres', '-d', db, '-c', query],
    { encoding: 'utf8' },
  )
  if (res.status !== 0) throw new Error(`psql failed: ${res.stderr}`)
  return res.stdout.trim()
}

const esc = (s: string) => s.replace(/'/g, "''")

async function signIn(page: Page, next: string) {
  await page.goto(`/api/test/login?next=${encodeURIComponent(next)}`)
}

async function newNote(page: Page) {
  await signIn(page, '/capture')
  await page.getByRole('button', { name: 'New note' }).first().click()
  await expect(page).toHaveURL(/\/capture\/notes\/[0-9a-f-]{36}\?new=1$/)
  const id = new URL(page.url()).pathname.split('/').pop()!
  await expect(page.getByLabel('Note', { exact: true })).toBeEditable()
  return id
}

test('a new note autosaves, is searchable with highlighted matches, and can be pinned', async ({ page }, info) => {
  const tag = `${info.project.name}${Date.now().toString(36)}`
  const id = await newNote(page)
  await page.getByLabel('Title (optional)').fill(`Garden plan ${tag}`)
  await page.getByLabel('Note', { exact: true }).fill('Plant tomatoes along the south fence.\nWater weekly.')
  await page.getByLabel('Date').fill('2026-03-01')
  await expect(page.getByTestId('sync-status')).toHaveText('Synced', { timeout: 15_000 })
  expect(sql(`select title || '|' || linked_date || '|' || version from public.notes where id = '${id}'`)).toMatch(
    new RegExp(`^Garden plan ${tag}\\|2026-03-01\\|\\d+$`),
  )

  await page.getByRole('button', { name: 'Pin' }).click()
  await expect(page.getByTestId('sync-status')).toHaveText('Synced', { timeout: 15_000 })
  expect(sql(`select pinned from public.notes where id = '${id}'`)).toBe('t')

  // Search by a word prefix; the match is highlighted.
  await page.goto('/capture')
  await page.getByRole('searchbox', { name: 'Search notes and journal' }).fill(`tomat ${tag}`)
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  const hit = page.getByTestId('note-hit').filter({ hasText: tag })
  await expect(hit).toHaveCount(1)
  await expect(hit.locator('mark').filter({ hasText: 'tomatoes' })).toBeVisible()
  await expect(hit.locator('mark').filter({ hasText: tag })).toBeVisible()
  // Search terms never go into the URL (or history, or access logs).
  expect(page.url()).not.toContain('tomat')

  // Pinned list.
  await page.goto('/capture?view=pinned')
  await expect(page.getByTestId('note-list')).toContainText(`Garden plan ${tag}`)

  // A search with no hits says so honestly.
  await page.getByRole('searchbox', { name: 'Search notes and journal' }).fill(`zzqx${tag}`)
  await page.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.getByText(/Nothing found for/)).toBeVisible()
})

test('a stale edit shows both versions and never overwrites silently', async ({ page }, info) => {
  const tag = `${info.project.name}${Date.now().toString(36)}`
  const id = await newNote(page)
  const editor = page.getByLabel('Note', { exact: true })
  await editor.fill(`Shopping ${tag}\nmilk`)
  await expect(page.getByTestId('sync-status')).toHaveText('Synced', { timeout: 15_000 })

  // Another device saves a newer version.
  sql(`update public.notes set body = '${esc(`Shopping ${tag}\nmilk\nfrom laptop`)}', version = version + 1 where id = '${id}'`)
  await editor.fill(`Shopping ${tag}\nmilk\nfrom phone`)

  const conflict = page.getByRole('region', { name: 'This note was changed on another device' })
  await expect(conflict).toBeVisible({ timeout: 15_000 })
  await expect(conflict.getByTestId('conflict-mine')).toContainText('from phone')
  await expect(conflict.getByTestId('conflict-theirs')).toContainText('from laptop')
  // Nothing was overwritten while the owner decides.
  expect(sql(`select body from public.notes where id = '${id}'`)).toContain('from laptop')

  await conflict.getByRole('button', { name: 'Merge…' }).click()
  const merged = conflict.getByLabel('Merged note')
  await expect(merged).toHaveValue(/from phone[\s\S]*from laptop/)
  await merged.fill(`Shopping ${tag}\nmilk\nfrom phone\nfrom laptop`)
  await conflict.getByRole('button', { name: 'Save merged version' }).click()
  await expect(page.getByTestId('sync-status')).toHaveText('Synced', { timeout: 15_000 })
  expect(sql(`select body from public.notes where id = '${id}'`)).toBe(`Shopping ${tag}\nmilk\nfrom phone\nfrom laptop`)
})

test('a note written while offline is kept on the device across a reload and syncs later', async ({ page }, info) => {
  const tag = `${info.project.name}${Date.now().toString(36)}`
  const id = await newNote(page)
  const block = (route: Route) => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue())
  await page.route('**/capture/notes/**', block)
  await page.getByLabel('Note', { exact: true }).fill(`Offline idea ${tag}`)
  await expect(page.getByTestId('sync-status')).toHaveText('Waiting to sync', { timeout: 15_000 })
  expect(sql(`select count(*) from public.notes where id = '${id}'`)).toBe('0')

  await page.reload()
  await expect(page.getByLabel('Note', { exact: true })).toHaveValue(`Offline idea ${tag}`)
  await page.unroute('**/capture/notes/**', block)
  await expect(page.getByTestId('sync-status')).toHaveText('Synced', { timeout: 30_000 })
  expect(sql(`select body from public.notes where id = '${id}'`)).toBe(`Offline idea ${tag}`)
})

test('deleting a note asks first and removes it', async ({ page }, info) => {
  const tag = `${info.project.name}${Date.now().toString(36)}`
  const id = await newNote(page)
  await page.getByLabel('Note', { exact: true }).fill(`Temporary ${tag}`)
  await expect(page.getByTestId('sync-status')).toHaveText('Synced', { timeout: 15_000 })
  await page.reload()
  await page.getByRole('button', { name: 'Delete…' }).click()
  await page.getByRole('button', { name: 'Delete note' }).click()
  await expect(page).toHaveURL(/\/capture$/)
  expect(sql(`select count(*) from public.notes where id = '${id}'`)).toBe('0')
})

test('signing out clears drafts kept on this device', async ({ page }, info) => {
  const tag = `${info.project.name}${Date.now().toString(36)}`
  await newNote(page)
  const block = (route: Route) => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue())
  await page.route('**/capture/notes/**', block)
  await page.getByLabel('Note', { exact: true }).fill(`Unsynced ${tag}`)
  await expect(page.getByTestId('sync-status')).toHaveText('Waiting to sync', { timeout: 15_000 })
  const names = () => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))
  expect(await names()).toContain('personal-home-drafts')

  await page.goto('/signed-out')
  await expect(page.getByRole('heading', { name: 'Signed out' })).toBeVisible()
  await expect.poll(names).not.toContain('personal-home-drafts')
})
