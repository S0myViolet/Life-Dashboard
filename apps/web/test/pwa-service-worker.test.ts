/**
 * The app-shell service worker (lib/pwa/service-worker.js), run in a VM sandbox
 * with an in-memory Cache Storage and a scripted network. Checks what it caches
 * (the shell only), what it intercepts, and the offline fallback.
 * The e2e suite (e2e/pwa.spec.ts) covers the same worker in a real browser.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { beforeEach, describe, expect, it } from 'vitest'

const ORIGIN = 'https://home.example.test'
const SOURCE = readFileSync(
  fileURLToPath(new URL('../lib/pwa/service-worker.js', import.meta.url)),
  'utf8',
)

type Req = { url: string; method: string; mode: string }
type Input = string | Req

const hrefOf = (input: Input) => new URL(typeof input === 'string' ? input : input.url, ORIGIN).href
const pathOf = (input: Input) => new URL(hrefOf(input)).pathname

class FakeCache {
  entries = new Map<string, Response>()
  async put(input: Input, response: Response) {
    this.entries.set(hrefOf(input), response)
  }
  async match(input: Input) {
    return this.entries.get(hrefOf(input))?.clone()
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }))
  }
}

class FakeCacheStorage {
  stores = new Map<string, FakeCache>()
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache())
    return this.stores.get(name)!
  }
  async keys() {
    return [...this.stores.keys()]
  }
  async delete(name: string) {
    return this.stores.delete(name)
  }
  async match(input: Input) {
    for (const store of this.stores.values()) {
      const hit = await store.match(input)
      if (hit) return hit
    }
    return undefined
  }
  paths() {
    return [...this.stores.entries()].flatMap(([name, store]) =>
      [...store.entries.keys()].map((href) => `${name} ${new URL(href).pathname}`),
    )
  }
}

// SYNTHETIC FIXTURE: the shape of `next build`'s /offline HTML (asset names are made up).
const OFFLINE_HTML = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="/_next/static/chunks/0a1b2c.css" data-precedence="next"/>
<script src="/_next/static/chunks/webpack-3d4e.js" async=""></script>
<script src="/_next/static/chunks/main-app-9f8e.js" async=""></script>
<script>self.__next_f.push([1,"\\"/_next/static/chunks/page-77aa.js\\""])</script>
<script src="https://cdn.example.test/_next/static/chunks/evil.js"></script>
</head><body><h1>You’re offline</h1></body></html>`

interface Sandbox {
  caches: FakeCacheStorage
  fetches: { path: string; credentials?: string; href: string }[]
  online: boolean
  skipWaiting: number
  claimed: number
  preload: boolean
  dispatch(type: string, event: Record<string, unknown>): void
}

function loadWorker(): Sandbox {
  const handlers = new Map<string, (event: unknown) => void>()
  const sandbox: Sandbox = {
    caches: new FakeCacheStorage(),
    fetches: [],
    online: true,
    skipWaiting: 0,
    claimed: 0,
    preload: false,
    dispatch(type, event) {
      const handler = handlers.get(type)
      if (!handler) throw new Error(`no ${type} handler`)
      handler(event)
    },
  }
  const fetch = async (input: Input, init: { credentials?: string } = {}) => {
    const href = hrefOf(input)
    sandbox.fetches.push({ path: pathOf(input), credentials: init.credentials, href })
    if (!sandbox.online) throw new TypeError('Failed to fetch')
    const path = pathOf(input)
    if (path === '/offline') {
      return new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html' } })
    }
    if (path === '/boom') return new Response('nope', { status: 500 })
    return new Response(`network ${path}`, { status: 200 })
  }
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) =>
      handlers.set(type, handler),
    skipWaiting: async () => {
      sandbox.skipWaiting++
    },
    clients: {
      claim: async () => {
        sandbox.claimed++
      },
    },
    registration: {
      navigationPreload: {
        enable: async () => {
          sandbox.preload = true
        },
      },
    },
  }
  const context = vm.createContext({
    self,
    caches: sandbox.caches,
    fetch,
    // Host (Node) web APIs; JavaScript builtins come from the sandbox itself.
    Response,
    URL,
  })
  vm.runInContext(SOURCE, context, { filename: 'service-worker.js' })
  return sandbox
}

/** Dispatch an extendable event and wait for everything it asked to wait for. */
async function extendable(sw: Sandbox, type: 'install' | 'activate') {
  const pending: Promise<unknown>[] = []
  sw.dispatch(type, { waitUntil: (p: Promise<unknown>) => pending.push(p) })
  await Promise.all(pending)
}

/** Dispatch a fetch event. Returns the response, or null when the worker did not intercept. */
async function request(
  sw: Sandbox,
  path: string,
  init: { method?: string; mode?: string; origin?: string } = {},
): Promise<Response | null> {
  const pending: Promise<unknown>[] = []
  let responded: Promise<Response> | null = null
  sw.dispatch('fetch', {
    request: {
      url: new URL(path, init.origin ?? ORIGIN).href,
      method: init.method ?? 'GET',
      mode: init.mode ?? 'cors',
    },
    preloadResponse: Promise.resolve(undefined),
    respondWith: (p: Promise<Response>) => {
      responded = p
    },
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  })
  const response = responded ? await responded : null
  await Promise.all(pending)
  return response
}

let sw: Sandbox

beforeEach(() => {
  sw = loadWorker()
})

describe('install', () => {
  it('caches only the offline page, its same-origin build assets, the manifest and icons', async () => {
    await extendable(sw, 'install')
    const cached = sw.caches.paths()
    expect(cached.every((entry) => entry.startsWith('personal-home-shell-v'))).toBe(true)
    expect(cached.map((entry) => entry.split(' ')[1]).sort()).toEqual(
      [
        '/_next/static/chunks/0a1b2c.css',
        '/_next/static/chunks/main-app-9f8e.js',
        '/_next/static/chunks/page-77aa.js',
        '/_next/static/chunks/webpack-3d4e.js',
        '/icons/apple-touch-icon.png',
        '/icons/icon-192.png',
        '/icons/icon.svg',
        '/manifest.webmanifest',
        '/offline',
      ].sort(),
    )
    expect(sw.fetches.every((f) => f.href.startsWith(ORIGIN))).toBe(true)
    expect(sw.skipWaiting).toBe(1)
  })

  it('fetches the shell without cookies, so it can never contain owner data', async () => {
    await extendable(sw, 'install')
    expect(sw.fetches.length).toBeGreaterThan(0)
    for (const f of sw.fetches) expect(f.credentials, f.path).toBe('omit')
  })

  it('fails the install (keeping the previous worker) when the shell cannot be fetched', async () => {
    sw.online = false
    await expect(extendable(sw, 'install')).rejects.toThrow()
    expect(sw.skipWaiting).toBe(0)
  })
})

describe('activate', () => {
  it('deletes older shell caches, keeps unrelated caches, and claims clients', async () => {
    await (await sw.caches.open('personal-home-shell-v0')).put('/offline', new Response('old'))
    await sw.caches.open('something-else')
    await extendable(sw, 'install')
    await extendable(sw, 'activate')
    const names = await sw.caches.keys()
    expect(names).not.toContain('personal-home-shell-v0')
    expect(names).toContain('something-else')
    expect(names.filter((n) => n.startsWith('personal-home-shell-'))).toHaveLength(1)
    expect(sw.claimed).toBe(1)
    expect(sw.preload).toBe(true)
  })
})

describe('fetch', () => {
  beforeEach(async () => {
    await extendable(sw, 'install')
    await extendable(sw, 'activate')
    sw.fetches = []
  })

  it('leaves non-GET, cross-origin, API, RSC and image requests to the network', async () => {
    expect(await request(sw, '/settings', { method: 'POST', mode: 'navigate' })).toBeNull()
    expect(await request(sw, '/', { origin: 'https://evil.example.test' })).toBeNull()
    expect(await request(sw, '/api/capture/v1/messages')).toBeNull()
    expect(await request(sw, '/settings?_rsc=abc12')).toBeNull()
    expect(await request(sw, '/_next/image?url=%2Fa.png&w=64&q=75')).toBeNull()
    expect(await request(sw, '/manifest.webmanifest?v=2')).toBeNull()
  })

  it('serves navigations from the network and never stores them', async () => {
    const before = sw.caches.paths()
    const response = await request(sw, '/settings', { mode: 'navigate' })
    expect(await response?.text()).toBe('network /settings')
    expect(sw.caches.paths()).toEqual(before)
  })

  it('falls back to the cached /offline page when a navigation fails', async () => {
    sw.online = false
    const response = await request(sw, '/settings/timezone', { mode: 'navigate' })
    expect(await response?.text()).toContain('You’re offline')
  })

  it('answers with a minimal offline page when the shell cache is gone (after sign-out)', async () => {
    for (const name of await sw.caches.keys()) await sw.caches.delete(name)
    sw.online = false
    const response = await request(sw, '/', { mode: 'navigate' })
    expect(response?.status).toBe(503)
    expect(await response?.text()).toContain('You are offline')
  })

  it('rebuilds a cleared shell on the next online navigation, but not on /signed-out', async () => {
    for (const name of await sw.caches.keys()) await sw.caches.delete(name)
    await request(sw, '/signed-out', { mode: 'navigate' })
    expect(sw.caches.paths()).toEqual([])
    await request(sw, '/login', { mode: 'navigate' })
    expect(sw.caches.paths().some((entry) => entry.endsWith(' /offline'))).toBe(true)
  })

  it('serves build assets cache-first and fetches the ones it does not have', async () => {
    sw.online = false
    const css = await request(sw, '/_next/static/chunks/0a1b2c.css')
    expect(await css?.text()).toBe('network /_next/static/chunks/0a1b2c.css')
    expect(sw.fetches).toEqual([])
    sw.online = true
    const other = await request(sw, '/_next/static/chunks/other.js')
    expect(await other?.text()).toBe('network /_next/static/chunks/other.js')
    expect(sw.caches.paths().some((e) => e.endsWith('/other.js'))).toBe(false)
  })

  it('serves the manifest and icons network-first with the cached copy offline', async () => {
    const online = await request(sw, '/manifest.webmanifest')
    expect(sw.fetches.map((f) => f.path)).toEqual(['/manifest.webmanifest'])
    expect(await online?.text()).toBe('network /manifest.webmanifest')
    sw.online = false
    const offline = await request(sw, '/icons/icon-192.png')
    expect(await offline?.text()).toBe('network /icons/icon-192.png') // the copy cached at install
  })
})
