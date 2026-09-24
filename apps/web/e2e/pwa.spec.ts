import { expect, test, type Page } from '@playwright/test'
import { owner, pngSize, resetOwnerSettings, signInAsOwner } from './helpers'

test.beforeEach(() => resetOwnerSettings())

test('the web app manifest is valid and its icons are real PNGs of the stated size', async ({
  request,
  page,
}) => {
  const res = await request.get('/manifest.webmanifest')
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toContain('application/manifest+json')
  const manifest = (await res.json()) as {
    name: string
    short_name: string
    start_url: string
    scope: string
    display: string
    background_color: string
    theme_color: string
    icons: { src: string; sizes: string; type: string; purpose?: string }[]
  }
  expect(manifest).toMatchObject({
    name: 'Personal Home',
    short_name: 'Home',
    start_url: '/',
    scope: '/',
    display: 'standalone',
  })
  expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i)
  expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i)

  const pngs = manifest.icons.filter((i) => i.type === 'image/png')
  expect(pngs.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
  expect(pngs.some((i) => i.purpose === 'maskable')).toBe(true)
  for (const icon of manifest.icons) {
    const r = await request.get(icon.src)
    expect(r.status(), icon.src).toBe(200)
    expect(r.headers()['content-type']).toContain(icon.type)
    if (icon.type === 'image/png') {
      const { width, height } = pngSize(await r.body())
      expect(`${width}x${height}`, icon.src).toBe(icon.sizes)
    }
  }

  // Apple touch icon from the document head.
  await page.goto('/login')
  const href = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')
  expect(href).toBe('/icons/apple-touch-icon.png')
  const apple = await request.get(href!)
  expect(pngSize(await apple.body())).toEqual({ width: 180, height: 180 })
})

async function cachedEntries(page: Page) {
  return page.evaluate(async () => {
    const out: { cache: string; path: string }[] = []
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      for (const req of await cache.keys()) out.push({ cache: name, path: new URL(req.url).pathname })
    }
    return out
  })
}

test('the service worker caches only the app shell and serves /offline when the network is cut', async ({
  page,
  context,
  request,
  baseURL,
}) => {
  await signInAsOwner(page)
  const registration = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready
    return { scope: reg.scope, script: reg.active?.scriptURL ?? '' }
  })
  expect(registration.scope).toBe(`${baseURL}/`)
  expect(new URL(registration.script).pathname).toBe('/_next/static/service-worker/sw.js')

  // Served so it may control the whole origin, and always revalidated.
  const sw = await request.get('/_next/static/service-worker/sw.js')
  expect(sw.headers()['service-worker-allowed']).toBe('/')
  expect(sw.headers()['cache-control']).toContain('max-age=0')

  // Take control of the page, then inspect what was cached.
  await page.reload()
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  await expect
    .poll(async () => (await cachedEntries(page)).some((e) => e.path === '/offline'))
    .toBe(true)
  const entries = await cachedEntries(page)
  for (const { cache, path } of entries) {
    expect(cache).toMatch(/^personal-home-shell-/)
    expect(
      path === '/offline' ||
        path === '/manifest.webmanifest' ||
        path.startsWith('/icons/') ||
        path.startsWith('/_next/static/'),
      `unexpected cached path ${path}`,
    ).toBe(true)
  }
  expect(entries.some((e) => e.path.endsWith('.css'))).toBe(true)
  // The cached offline page was fetched without cookies: no owner data in it.
  const offlineHtml = await page.evaluate(async () => {
    const res = await caches.match('/offline')
    return res ? res.text() : ''
  })
  expect(offlineHtml).toContain('offline')
  expect(offlineHtml).not.toContain(owner.email)
  expect(offlineHtml).not.toMatch(/Good (morning|afternoon|evening)|Europe\/London/)

  // Cut the network: navigations fall back to the cached, styled offline page.
  await context.setOffline(true)
  try {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'You’re offline' })).toBeVisible()
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(background).toBe('rgb(247, 246, 242)') // --color-canvas: the CSS came from the cache
    await page.reload()
    await expect(page.getByRole('heading', { name: 'You’re offline' })).toBeVisible()
  } finally {
    await context.setOffline(false)
  }

  // Back online, "Try again" reaches the real app.
  await page.getByRole('link', { name: 'Try again' }).click()
  await expect(page).toHaveURL(`${baseURL}/`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    /^(Good morning|Good afternoon|Good evening|Hello)$/,
  )
})

test('signing out clears the service worker caches', async ({ page }) => {
  await signInAsOwner(page, '/settings')
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await expect
    .poll(async () => (await cachedEntries(page)).length, { timeout: 15_000 })
    .toBeGreaterThan(0)
  await page.getByRole('main').getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/signed-out$/)
  await expect.poll(async () => (await cachedEntries(page)).length).toBe(0)
})
