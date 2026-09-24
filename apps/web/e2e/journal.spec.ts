/**
 * Journal flows in Chromium with a fake microphone (--use-fake-device-for-media-stream,
 * --use-fake-ui-for-media-stream). Runs under the Playwright harness in playwright.config.ts
 * (test-only sign-in, seeded owner, PH_E2E_DATABASE). AI transcription is not configured in this
 * environment, which is exactly the failure path under test: nothing is transcribed, the recording
 * is kept with Retry / Download / Delete and a visible expiry, and typing keeps working.
 */
import { spawnSync } from 'node:child_process'
import { expect, test as base, type Page } from '@playwright/test'

const FAKE_MEDIA = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']

const test = base.extend({
  launchOptions: [
    async ({ launchOptions }, use) => {
      await use({ ...launchOptions, args: [...(launchOptions.args ?? []), ...FAKE_MEDIA] })
    },
    { scope: 'worker' },
  ],
})

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

async function signIn(page: Page, next: string) {
  await page.goto(`/api/test/login?next=${encodeURIComponent(next)}`)
}

/** Each test works on its own past date, reset before the test (both projects share one database). */
function resetDay(date: string) {
  sql(`delete from public.journal_entries where local_date = '${date}'`)
}

const entryBody = (date: string) => sql(`select body from public.journal_entries where local_date = '${date}'`)

test('a typed entry and prompt answers are saved and survive a reload', async ({ page }) => {
  const date = '2026-01-10'
  resetDay(date)
  await signIn(page, `/capture/journal/${date}`)
  await expect(page.getByTestId('journal-date')).toContainText('10 January 2026')

  await page.getByLabel('Entry', { exact: true }).fill('Walked by the river and planned the week.')
  await page.getByText('Prompts').click()
  await page.getByLabel('What moved forward').fill('Finished the draft')
  await expect(page.getByTestId('sync-status').first()).toHaveText('Synced', { timeout: 15_000 })

  expect(entryBody(date)).toBe('Walked by the river and planned the week.')
  expect(sql(`select prompts->>'moved_forward' from public.journal_entries where local_date = '${date}'`)).toBe(
    'Finished the draft',
  )
  // No mood field anywhere.
  await expect(page.getByText(/mood/i)).toHaveCount(0)

  await page.reload()
  await expect(page.getByLabel('Entry', { exact: true })).toHaveValue('Walked by the river and planned the week.')
  await expect(page.getByLabel('What moved forward')).toHaveValue('Finished the draft')
})

test('typing while the server is unreachable is kept on the device, survives a reload and syncs later', async ({ page }) => {
  const date = '2026-01-11'
  resetDay(date)
  await signIn(page, `/capture/journal/${date}`)
  const entry = page.getByLabel('Entry', { exact: true })
  await expect(entry).toBeEditable()

  // Server Actions are POSTs to the page: fail them all, as if offline.
  const blockPosts = async (route: import('@playwright/test').Route) =>
    route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue()
  await page.route('**/capture/journal/**', blockPosts)
  await entry.fill('Written without a connection.')
  await expect(page.getByTestId('sync-status').first()).toHaveText('Waiting to sync', { timeout: 15_000 })
  expect(entryBody(date)).toBe('')

  await page.reload()
  await expect(page.getByLabel('Entry', { exact: true })).toHaveValue('Written without a connection.')
  await expect(page.getByText(/saved on this device and (waiting|not yet)/i)).toBeVisible()

  await page.unroute('**/capture/journal/**', blockPosts)
  await expect(page.getByTestId('sync-status').first()).toHaveText('Synced', { timeout: 30_000 })
  expect(entryBody(date)).toBe('Written without a connection.')
})

test('record → upload → transcription unavailable keeps the recording with retry, download, delete and expiry', async ({
  page,
}) => {
  const date = '2026-01-12'
  resetDay(date)
  await signIn(page, `/capture/journal/${date}`)

  await page.getByRole('button', { name: 'Record' }).click()
  await expect(page.getByTestId('recording-timer')).toContainText('0:02', { timeout: 10_000 })
  await expect(page.getByTestId('recording-timer')).toContainText('of 15:00')
  await page.getByRole('button', { name: 'Stop recording' }).click()

  const item = page.getByTestId('recording-item')
  await expect(item).toHaveCount(1, { timeout: 20_000 })
  await expect(item).toHaveAttribute('data-status', 'failed', { timeout: 20_000 })
  await expect(item.getByTestId('recording-message')).toContainText('Transcription is not set up yet')
  await expect(item.getByTestId('recording-expiry')).toContainText('Kept until')
  await expect(item.getByRole('button', { name: 'Retry' })).toBeVisible()
  await expect(item.getByRole('link', { name: 'Download' })).toBeVisible()
  await expect(item.getByRole('button', { name: 'Delete' })).toBeVisible()

  const row = sql(
    `select r.status || '|' || r.failure_reason || '|' || (r.expires_at - r.created_at)::text || '|' || r.mime_type || '|' ||
       (select count(*) from public.journal_recording_chunks c where c.recording_id = r.id) || '|' || r.byte_size
     from public.journal_recordings r join public.journal_entries e on e.id = r.entry_id where e.local_date = '${date}'`,
  )
  const [status, reason, ttl, mime, chunks, bytes] = row.split('|')
  expect([status, reason, ttl]).toEqual(['failed', 'not_configured', '7 days'])
  expect(mime).toMatch(/^audio\/webm/)
  expect(Number(chunks)).toBeGreaterThanOrEqual(1)
  expect(Number(bytes)).toBeGreaterThan(0)
  expect(sql(`select coalesce(transcript_draft, '<none>') from public.journal_entries where local_date = '${date}'`)).toBe('<none>')

  // The owner can still type.
  await page.getByLabel('Entry', { exact: true }).fill('Typed instead.')
  await expect(page.getByTestId('sync-status').first()).toHaveText('Synced', { timeout: 15_000 })

  // Retry: still not configured, still kept (attempt 2), expiry unchanged.
  const expiryBefore = sql(`select expires_at from public.journal_recordings r join public.journal_entries e on e.id = r.entry_id where e.local_date = '${date}'`)
  await item.getByRole('button', { name: 'Retry' }).click()
  await expect.poll(() => sql(`select attempts from public.journal_recordings r join public.journal_entries e on e.id = r.entry_id where e.local_date = '${date}'`)).toBe('2')
  await expect(item).toHaveAttribute('data-status', 'failed')
  expect(sql(`select expires_at from public.journal_recordings r join public.journal_entries e on e.id = r.entry_id where e.local_date = '${date}'`)).toBe(expiryBefore)

  // Download gives back the audio.
  const download = page.waitForEvent('download')
  await item.getByRole('link', { name: 'Download' }).click()
  expect((await download).suggestedFilename()).toMatch(new RegExp(`^journal-${date}-[0-9a-f]{8}\\.webm$`))

  // Delete removes it (and its chunks).
  await item.getByRole('button', { name: 'Delete' }).click()
  await item.getByRole('button', { name: 'Delete recording' }).click()
  await expect(page.getByTestId('recording-item')).toHaveCount(0)
  expect(sql(`select count(*) from public.journal_recordings r join public.journal_entries e on e.id = r.entry_id where e.local_date = '${date}'`)).toBe('0')
  expect(entryBody(date)).toBe('Typed instead.')
})

test('microphone denied: a clear message, and typing still works', async ({ page }) => {
  const date = '2026-01-13'
  resetDay(date)
  await page.addInitScript(() => {
    const deny = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = deny
  })
  await signIn(page, `/capture/journal/${date}`)
  await page.getByRole('button', { name: 'Record' }).click()
  await expect(page.getByTestId('recorder-error')).toContainText('Microphone access is blocked')
  await expect(page.getByTestId('recorder-error')).toContainText('type your entry instead')
  await expect(page.getByRole('button', { name: 'Record' })).toBeEnabled()

  await page.getByLabel('Entry', { exact: true }).fill('No microphone today.')
  await expect(page.getByTestId('sync-status').first()).toHaveText('Synced', { timeout: 15_000 })
  expect(entryBody(date)).toBe('No microphone today.')
  expect(sql(`select count(*) from public.journal_recordings r join public.journal_entries e on e.id = r.entry_id where e.local_date = '${date}'`)).toBe('0')
})

test('a transcript is an editable draft; adding it saves the edited text and deletes the recording', async ({ page }) => {
  const date = '2026-01-14'
  resetDay(date)
  // Seed what a successful transcription leaves behind (the AI gateway is not configured here).
  sql(`
    with e as (
      insert into public.journal_entries (local_date, body, origin, transcript_draft, transcript_status)
      values ('${date}', 'Typed earlier.', 'voice', 'Machine transcript with a mistaek.', 'ready_for_review') returning id
    ), r as (
      insert into public.journal_recordings (entry_id, mime_type, byte_size, expected_chunks, status, uploaded_at)
      select id, 'audio/webm', 3, 1, 'transcribed', now() from e returning id
    )
    insert into public.journal_recording_chunks (recording_id, seq, data) select id, 0, '\\x010203'::bytea from r
  `)
  await signIn(page, `/capture/journal/${date}`)
  const review = page.getByTestId('transcript-review')
  await expect(review).toBeVisible()
  const box = review.getByLabel('Transcript')
  await expect(box).toHaveValue('Machine transcript with a mistaek.')
  // Not saved as final: the entry text is unchanged until the owner adds it.
  expect(entryBody(date)).toBe('Typed earlier.')

  await box.fill('Machine transcript with a mistake, fixed.')
  await review.getByRole('button', { name: 'Add to entry' }).click()
  await expect(page.getByTestId('transcript-review')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByLabel('Entry', { exact: true })).toHaveValue('Typed earlier.\n\nMachine transcript with a mistake, fixed.')
  expect(entryBody(date)).toBe('Typed earlier.\n\nMachine transcript with a mistake, fixed.')
  expect(sql(`select count(*) from public.journal_recordings r join public.journal_entries e on e.id = r.entry_id where e.local_date = '${date}'`)).toBe('0')
})
