/**
 * Personal Home service worker.
 *
 * Registered from lib/pwa/register-service-worker.tsx via
 * `new URL('./service-worker.js', import.meta.url)` (Next 16 PWA guide); the
 * bundler emits it under /_next/static/ with `Service-Worker-Allowed: /`.
 *
 * What it caches — the app shell only:
 *   - the /offline page (fetched WITHOUT cookies, so it can never contain owner data),
 *     the /_next/static assets that page references, the manifest and icons.
 * What it never caches: page HTML for signed-in routes, RSC payloads, API or
 * server-action responses, images from /_next/image, anything cross-origin.
 *
 * Navigations are network-first; only when the network fails does it answer
 * with the cached /offline page. Nothing is written to the cache at runtime
 * except re-creating the shell after the /signed-out page cleared it.
 *
 * Bump SHELL_VERSION whenever this file's caching behaviour changes. The
 * /signed-out page deletes every Cache Storage entry, which covers these names.
 */
const SHELL_VERSION = 'v1'
const CACHE_PREFIX = 'personal-home-shell'
const SHELL_CACHE = `${CACHE_PREFIX}-${SHELL_VERSION}`
const OFFLINE_URL = '/offline'
const SIGNED_OUT_URL = '/signed-out'
const SHELL_URLS = [
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/apple-touch-icon.png',
]
const STATIC_PREFIX = '/_next/static/'
const MAX_OFFLINE_ASSETS = 60

/** Static asset URLs (same origin) referenced by the offline page's HTML. */
function staticAssetsIn(html) {
  const found = new Set()
  const re = /\/_next\/static\/[A-Za-z0-9_\-./~%]+?\.(?:js|css|woff2?)(?=["'?#\s)\\])/g
  let match
  while ((match = re.exec(html)) !== null && found.size < MAX_OFFLINE_ASSETS) {
    if (!match[0].includes('..')) found.add(match[0])
  }
  return [...found]
}

async function fetchForShell(url) {
  // credentials: 'omit' — the shell must render the same for everyone, signed in or not.
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error' })
  if (!response.ok) throw new Error(`shell fetch failed: ${url} ${response.status}`)
  return response
}

async function buildShell() {
  const cache = await caches.open(SHELL_CACHE)
  const offline = await fetchForShell(OFFLINE_URL)
  const html = await offline.clone().text()
  const assets = staticAssetsIn(html)
  const responses = await Promise.all(
    [...SHELL_URLS, ...assets].map(async (url) => [url, await fetchForShell(url)]),
  )
  for (const [url, response] of responses) await cache.put(url, response)
  // Store the offline page last, so its presence means the shell is complete.
  await cache.put(OFFLINE_URL, offline)
}

async function shellIsComplete() {
  const cache = await caches.open(SHELL_CACHE)
  return Boolean(await cache.match(OFFLINE_URL))
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await buildShell()
      // Safe: no cached page depends on a particular app version except /offline,
      // whose assets are cached alongside it.
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE)
          .map((key) => caches.delete(key)),
      )
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable()
      }
      await self.clients.claim()
    })(),
  )
})

async function offlineResponse() {
  const cache = await caches.open(SHELL_CACHE)
  const cached = await cache.match(OFFLINE_URL)
  if (cached) return cached
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Offline</title><p>You are offline. Reconnect and try again.</p>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

async function handleNavigation(event) {
  try {
    const preloaded = await event.preloadResponse
    const response = preloaded || (await fetch(event.request))
    // The /signed-out page clears Cache Storage; rebuild the shell quietly on a later
    // navigation (not on /signed-out itself, which is busy clearing it).
    if (new URL(event.request.url).pathname !== SIGNED_OUT_URL) {
      event.waitUntil(
        shellIsComplete()
          .then((complete) => (complete ? undefined : buildShell()))
          .catch(() => undefined),
      )
    }
    return response
  } catch {
    return offlineResponse()
  }
}

/** Content-hashed build assets: the offline page's copies are served from the shell cache. */
async function handleStaticAsset(request) {
  const cache = await caches.open(SHELL_CACHE)
  const cached = await cache.match(request)
  return cached || fetch(request)
}

/** Manifest and icons: network first so updates show up, cached copy when offline. */
async function handleShellFile(request) {
  try {
    return await fetch(request)
  } catch (error) {
    const cache = await caches.open(SHELL_CACHE)
    const cached = await cache.match(request)
    if (cached) return cached
    throw error
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event))
    return
  }
  if (url.pathname.startsWith(STATIC_PREFIX)) {
    event.respondWith(handleStaticAsset(request))
    return
  }
  if (SHELL_URLS.includes(url.pathname) && url.search === '') {
    event.respondWith(handleShellFile(request))
  }
  // Everything else (RSC payloads, API routes, server actions, images) goes straight to the network.
})
