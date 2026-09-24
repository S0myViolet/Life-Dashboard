/**
 * Service-worker controller with a fake Chrome API and a fake dashboard
 * (SYNTHETIC responses shaped like /api/capture/v1/*; the real handlers are
 * tested in apps/web/test/capture-routes.test.ts against a real database).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { CaptureSelectionItem, CaptureSnapshot, CaptureStatusReport } from '@personal-home/core'
import { Background, TICK_ALARM, TIMING, type MessageSender } from '../src/background/background.ts'
import type { ChromeApi, TabInfo } from '../src/background/chrome-api.ts'
import { STATE_DEFAULTS, type StoredState } from '../src/background/state.ts'
import type { Badge } from '../src/shared/badge.ts'
import type { HelloResponse, HelperStateView, PageObservation, PairResult } from '../src/shared/protocol.ts'
import { REVISIT } from '../src/shared/revisit.ts'
import { CHAT_ID, CHAT_URL, CLAUDE_ID, CLAUDE_URL } from './helpers.ts'

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop'
const DASH = 'https://home.example.com'
const TOKEN = `phc_${'T'.repeat(43)}`
const CODE = 'ABCD-EFGH-JKMN'

class FakeChrome implements ChromeApi {
  readonly extensionId = EXT_ID
  readonly version = '0.1.0'
  store: StoredState = STATE_DEFAULTS()
  alarms = new Set<string>()
  granted = new Set<string>()
  tabs = new Map<number, string>([[1, 'https://news.example/'], [2, CHAT_URL]])
  nextTabId = 100
  created: string[] = []
  removed: number[] = []
  opened: string[] = []
  notices: number[] = []
  badge: Badge | null = null
  /** Whether chrome.storage.local accepts TRUSTED_CONTEXTS (Chromium 141 does); calls so far. */
  restrictable = true
  restricted = 0

  async storageGet<K extends keyof StoredState>(keys: K[]) {
    const out = {} as Pick<StoredState, K>
    for (const k of keys) out[k] = structuredClone(this.store[k])
    return out
  }
  async storageSet(patch: Partial<StoredState>) {
    if (patch.pairing?.token && this.restricted === 0) throw new Error('token written before storage was restricted')
    this.store = { ...this.store, ...structuredClone(patch) }
  }
  async restrictStorage() {
    if (this.restrictable) this.restricted++
    return this.restrictable
  }
  async alarmExists(name: string) {
    return this.alarms.has(name)
  }
  async alarmCreate(name: string) {
    this.alarms.add(name)
  }
  async tabsCreateBackground(url: string): Promise<TabInfo> {
    const id = this.nextTabId++
    this.tabs.set(id, url)
    this.created.push(url)
    return { id, url }
  }
  async tabsKeepAlive() {}
  async tabsRemove(tabId: number) {
    this.removed.push(tabId)
    this.tabs.delete(tabId)
  }
  async tabsQuery() {
    return [...this.tabs].filter(([, url]) => /chatgpt\.com|claude\.ai/.test(url)).map(([id, url]) => ({ id, url }))
  }
  async tabsSendMessage(tabId: number) {
    this.notices.push(tabId)
  }
  async openPage(url: string) {
    this.opened.push(url)
  }
  async openOptionsPage() {}
  async setBadge(b: Badge) {
    this.badge = b
  }
  async hasHostPermission(pattern: string) {
    return this.granted.has(pattern)
  }
}

interface Req {
  method: string
  path: string
  auth: string | null
  body: unknown
}

const selectionItem = (provider: 'chatgpt' | 'claude', state: CaptureSelectionItem['captureState'] = 'active'): CaptureSelectionItem =>
  provider === 'chatgpt'
    ? { id: '00000000-0000-4000-8000-000000000001', provider, externalId: CHAT_ID, url: CHAT_URL, captureState: state }
    : { id: '00000000-0000-4000-8000-000000000002', provider, externalId: CLAUDE_ID, url: CLAUDE_URL, captureState: state }

class FakeDashboard {
  requests: Req[] = []
  selection: CaptureSelectionItem[] = [selectionItem('chatgpt')]
  down = false
  revoked = false
  snapshotStatus = 200
  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    if (this.down) throw new TypeError('Failed to fetch')
    const url = new URL(input)
    const headers = new Headers(init?.headers)
    const req: Req = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      auth: headers.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    }
    this.requests.push(req)
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.origin !== DASH) return json(404, { error: 'not_found' })
    if (req.path === '/api/capture/v1/pair') {
      const body = req.body as { code: string }
      if (body.code === 'YYYYYYYYYYYY') return json(429, { error: 'too_many_attempts' })
      return body.code === 'ABCDEFGHJKMN'
        ? json(201, { token: TOKEN, dashboardOrigin: DASH, deviceId: '00000000-0000-4000-8000-00000000000d' })
        : json(401, { error: 'invalid_or_expired_code' })
    }
    if (this.revoked || req.auth !== `Bearer ${TOKEN}`) return json(401, { error: 'invalid_token' })
    if (req.path === '/api/capture/v1/selection') {
      return json(200, { conversations: this.selection, syncedAt: new Date().toISOString() })
    }
    if (req.path === '/api/capture/v1/snapshots') {
      if (this.snapshotStatus !== 200) return json(this.snapshotStatus, { error: 'server_error' })
      const snap = req.body as CaptureSnapshot
      return json(200, {
        outcome: 'applied',
        newMessages: snap.messages.length,
        newVersions: 0,
        captureState: 'active',
        duplicate: false,
      })
    }
    if (req.path === '/api/capture/v1/status') {
      const r = req.body as CaptureStatusReport
      return json(200, { captureState: r.state === 'challenge' ? 'needs_attention' : r.state })
    }
    return json(404, { error: 'not_found' })
  }
  paths = () => this.requests.map((r) => `${r.method} ${r.path}`)
}

const PAGE: MessageSender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html` }
const contentSender = (tabId: number, url = CHAT_URL): MessageSender => ({ id: EXT_ID, url, tab: { id: tabId } })

const observation = (url = CHAT_URL, count = 2, sessionId = 'visit-1'): PageObservation => ({
  url,
  title: 'Synthetic',
  sessionId,
  capturedAt: new Date(clockNow).toISOString(),
  messages: Array.from({ length: count }, (_, i) => ({
    key: `m-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `synthetic ${i}`,
    orderHint: i,
    isStreaming: false,
  })),
  observedFirstMessage: true,
  observedLastMessage: true,
  contiguous: true,
  missingCount: 0,
  renderedCount: count,
  streamingInProgress: false,
})

let clockNow = Date.parse('2026-09-24T12:00:00Z')
let chrome: FakeChrome
let dash: FakeDashboard
let bg: Background
let ids = 0

async function paired() {
  chrome.granted.add(`https://home.example.com/*`)
  const res = (await bg.onMessage({ type: 'ph:pair', apiOrigin: DASH, code: CODE, deviceName: 'Laptop' }, PAGE)) as PairResult
  expect(res.ok).toBe(true)
}

beforeEach(() => {
  clockNow = Date.parse('2026-09-24T12:00:00Z')
  chrome = new FakeChrome()
  dash = new FakeDashboard()
  ids = 0
  bg = new Background(chrome, dash.fetch, () => clockNow, () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`)
})

describe('pairing', () => {
  it('needs the dashboard host permission, then stores the token once and never shows it', async () => {
    const denied = (await bg.onMessage({ type: 'ph:pair', apiOrigin: DASH, code: CODE, deviceName: 'Laptop' }, PAGE)) as PairResult
    expect(denied).toMatchObject({ ok: false, error: 'permission_missing' })
    expect(dash.requests).toHaveLength(0)

    await paired()
    expect(chrome.store.pairing).toMatchObject({ apiOrigin: DASH, token: TOKEN, deviceName: 'Laptop' })
    expect(dash.paths()).toEqual(['POST /api/capture/v1/pair', 'GET /api/capture/v1/selection'])
    const view = (await bg.onMessage({ type: 'ph:get-state' }, PAGE)) as HelperStateView
    expect(JSON.stringify(view)).not.toContain(TOKEN)
    expect(view).toMatchObject({ paired: true, apiOrigin: DASH, conversations: [{ externalId: CHAT_ID }] })
    expect(chrome.alarms.has(TICK_ALARM)).toBe(true)
  })

  it('keeps the token where content scripts cannot read it, or does not pair at all', async () => {
    chrome.granted.add('https://home.example.com/*')
    chrome.restrictable = false
    const refused = (await bg.onMessage({ type: 'ph:pair', apiOrigin: DASH, code: CODE, deviceName: 'Laptop' }, PAGE)) as PairResult
    expect(refused).toMatchObject({ ok: false, error: 'storage_not_private' })
    expect(dash.requests).toHaveLength(0) // the one-time code is not spent
    expect(chrome.store.pairing).toBeNull()

    chrome.restrictable = true
    await paired()
    expect(chrome.restricted).toBeGreaterThan(0)
    expect(chrome.store.pairing?.token).toBe(TOKEN)
  })

  it('validates the address and code before calling anything, and explains a refused code', async () => {
    chrome.granted.add('https://home.example.com/*')
    for (const apiOrigin of ['http://home.example.com', 'javascript:alert(1)', 'not a url']) {
      const r = (await bg.onMessage({ type: 'ph:pair', apiOrigin, code: CODE, deviceName: 'x' }, PAGE)) as PairResult
      expect(r).toMatchObject({ ok: false, error: 'invalid_origin' })
    }
    const badCode = (await bg.onMessage({ type: 'ph:pair', apiOrigin: DASH, code: '123', deviceName: 'x' }, PAGE)) as PairResult
    expect(badCode).toMatchObject({ ok: false, error: 'invalid_code' })
    expect(dash.requests).toHaveLength(0)
    const refused = (await bg.onMessage(
      { type: 'ph:pair', apiOrigin: DASH, code: 'ZZZZ-ZZZZ-ZZZZ', deviceName: 'x' },
      PAGE,
    )) as PairResult
    expect(refused).toMatchObject({ ok: false, error: 'invalid_or_expired_code' })
    const limited = (await bg.onMessage(
      { type: 'ph:pair', apiOrigin: DASH, code: 'YYYY-YYYY-YYYY', deviceName: 'x' },
      PAGE,
    )) as PairResult
    expect(limited).toMatchObject({ ok: false, error: 'too_many_attempts' })
    if (!limited.ok) expect(limited.message).toContain('Wait 10 minutes')
  })

  it('refuses owner actions from content scripts and anything from other extensions', async () => {
    const fromPage = await bg.onMessage({ type: 'ph:pair', apiOrigin: DASH, code: CODE, deviceName: 'x' }, contentSender(2))
    expect(fromPage).toEqual({ error: 'bad_request' })
    const foreign = await bg.onMessage({ type: 'ph:get-state' }, { id: 'someone-else', url: 'chrome-extension://x/' })
    expect(foreign).toEqual({ error: 'forbidden' })
    const otherSite = await bg.onMessage({ type: 'ph:hello', url: CHAT_URL }, contentSender(1, 'https://evil.example/'))
    expect(otherSite).toEqual({ error: 'forbidden' })
  })
})

describe('collecting', () => {
  it('tells pages whether to collect', async () => {
    const hello = (url: string) => bg.onMessage({ type: 'ph:hello', url }, contentSender(2, url)) as Promise<HelloResponse>
    expect(await hello(CHAT_URL)).toMatchObject({ collect: false, reason: 'not_paired' })
    await paired()
    expect(await hello(CHAT_URL)).toEqual({ collect: true, mode: 'passive' })
    expect(await hello('https://chatgpt.com/')).toMatchObject({ collect: false, reason: 'not_conversation' })
    // Unselected: one re-sync (the owner may have just selected it), then no.
    const before = dash.requests.length
    expect(await hello(CLAUDE_URL)).toMatchObject({ collect: false, reason: 'not_selected' })
    expect(dash.requests.length).toBe(before + 1)
    dash.selection.push(selectionItem('claude'))
    expect(await hello(CLAUDE_URL)).toMatchObject({ collect: false, reason: 'not_selected' }) // rate-limited
    clockNow += TIMING.helloResyncMs + 1
    expect(await hello(CLAUDE_URL)).toEqual({ collect: true, mode: 'passive' })

    await bg.onMessage({ type: 'ph:set-paused-all', paused: true }, PAGE)
    expect(await hello(CHAT_URL)).toMatchObject({ collect: false, reason: 'paused_all' })
    expect(chrome.badge?.text).toBe('OFF')
  })

  it('uploads an observation as a valid v1 snapshot with the bearer token', async () => {
    await paired()
    const res = await bg.onMessage({ type: 'ph:observation', observation: observation() }, contentSender(2))
    expect(res).toEqual({ accepted: true, queued: 1 })
    const upload = dash.requests.find((r) => r.path === '/api/capture/v1/snapshots')!
    expect(upload.auth).toBe(`Bearer ${TOKEN}`)
    expect(upload.body).toMatchObject({
      schemaVersion: 1,
      provider: 'chatgpt',
      conversation: { externalId: CHAT_ID, url: CHAT_URL },
      coverage: { mode: 'passive', pageState: 'ok', observedFirstMessage: true, contiguous: true, missingCount: 0 },
    })
    expect(chrome.store.queue).toHaveLength(0)
    const view = (await bg.onMessage({ type: 'ph:get-state' }, PAGE)) as HelperStateView
    expect(view.conversations[0]!.lastResult).toBe('applied: 2 new, 0 edited')
  })

  it('never upgrades a gap in the page visit into a gap-free claim', async () => {
    await paired()
    const gapped = { ...observation(), contiguous: 'yes', missingCount: 28 } as unknown as PageObservation
    await bg.onMessage({ type: 'ph:observation', observation: gapped }, contentSender(2))
    const upload = dash.requests.find((r) => r.path === '/api/capture/v1/snapshots')!
    expect((upload.body as CaptureSnapshot).coverage).toMatchObject({ contiguous: false, missingCount: 28 })
  })

  it('refuses observations for unselected conversations', async () => {
    await paired()
    const res = await bg.onMessage({ type: 'ph:observation', observation: observation(CLAUDE_URL) }, contentSender(3, CLAUDE_URL))
    expect(res).toEqual({ accepted: false, queued: 0 })
    expect(dash.paths()).not.toContain('POST /api/capture/v1/snapshots')
  })

  it('queues while offline, supersedes within a visit, and catches up on wake', async () => {
    await paired()
    await bg.onAlarm(TICK_ALARM) // the minute alarm has been ticking
    dash.down = true
    await bg.onMessage({ type: 'ph:observation', observation: observation(CHAT_URL, 2) }, contentSender(2))
    await bg.onMessage({ type: 'ph:observation', observation: observation(CHAT_URL, 3) }, contentSender(2))
    expect(chrome.store.queue).toHaveLength(1) // the second visit state replaced the first
    expect(chrome.store.queue[0]!.attempts).toBeGreaterThan(0)
    expect(chrome.badge?.text).toBe('1')

    // Laptop sleeps for an hour; the missed alarm fires once on wake.
    dash.down = false
    clockNow += 60 * 60_000
    await bg.onAlarm(TICK_ALARM)
    expect(chrome.store.queue).toHaveLength(0)
    const upload = dash.requests.filter((r) => r.path === '/api/capture/v1/snapshots').at(-1)!
    expect((upload.body as CaptureSnapshot).messages).toHaveLength(3)
    expect(chrome.store.log.some((l) => /Woke up/.test(l.text))).toBe(true)
    expect(chrome.notices).toContain(2) // open conversation tabs are asked to re-check
  })

  it('stops on a revoked token and keeps the queue until re-paired', async () => {
    await paired()
    dash.revoked = true
    await bg.onMessage({ type: 'ph:observation', observation: observation() }, contentSender(2))
    expect(chrome.store.pairing?.authFailedAt).not.toBeNull()
    expect(chrome.store.queue).toHaveLength(1)
    expect(chrome.badge?.text).toBe('!')
    const hello = (await bg.onMessage({ type: 'ph:hello', url: CHAT_URL }, contentSender(2))) as HelloResponse
    expect(hello).toMatchObject({ collect: false, reason: 'auth_failed' })
  })

  it('reports a signed-out page, pauses the conversation locally and badges it', async () => {
    await paired()
    await bg.onMessage({ type: 'ph:problem', url: CHAT_URL, state: 'signed_out' }, contentSender(2))
    const status = dash.requests.find((r) => r.path === '/api/capture/v1/status')!
    expect(status.body).toMatchObject({ provider: 'chatgpt', externalId: CHAT_ID, state: 'signed_out', mode: 'passive' })
    const hello = (await bg.onMessage({ type: 'ph:hello', url: CHAT_URL }, contentSender(2))) as HelloResponse
    expect(hello).toMatchObject({ collect: false, reason: 'not_active' })
    expect(chrome.badge?.text).toBe('!')
    expect(chrome.store.revisit.blocked.chatgpt?.reason).toBe('signed_out')
  })

  it('unpairing deletes the token and queued captures', async () => {
    await paired()
    dash.down = true
    await bg.onMessage({ type: 'ph:observation', observation: observation() }, contentSender(2))
    await bg.onMessage({ type: 'ph:unpair' }, PAGE)
    expect(chrome.store.pairing).toBeNull()
    expect(chrome.store.queue).toEqual([])
  })

  it('opens the dashboard attach page for "Track this conversation"', async () => {
    await paired()
    await bg.onMessage({ type: 'ph:track', url: `${CLAUDE_URL}?foo=1#x` }, PAGE)
    expect(chrome.opened).toEqual([`${DASH}/projects/attach?url=${encodeURIComponent(CLAUDE_URL)}`])
    expect(await bg.onMessage({ type: 'ph:track', url: 'https://evil.example/c/x' }, PAGE)).toEqual({
      ok: false,
      error: 'not_conversation',
    })
  })
})

describe('revisit prototype', () => {
  it('is off by default and cannot be turned on without acknowledging the terms note', async () => {
    await paired()
    await bg.onAlarm(TICK_ALARM)
    expect(chrome.created).toEqual([])
    await bg.onMessage({ type: 'ph:set-revisit', enabled: true, acknowledged: false }, PAGE)
    expect(chrome.store.settings.revisitEnabled).toBe(false)
    expect(chrome.created).toEqual([])
  })

  it('opens one background tab per service, captures, and closes only its own tab', async () => {
    dash.selection = [selectionItem('chatgpt'), selectionItem('claude')]
    await paired()
    clockNow += REVISIT.intervalMs
    await bg.onMessage({ type: 'ph:set-revisit', enabled: true, acknowledged: true }, PAGE)
    expect(chrome.created.sort()).toEqual([CHAT_URL, CLAUDE_URL].sort())
    const collectors = chrome.store.revisit.collectors
    expect(collectors).toHaveLength(2)
    const gptTab = collectors.find((c) => c.provider === 'chatgpt')!.tabId

    const hello = (await bg.onMessage({ type: 'ph:hello', url: CHAT_URL }, contentSender(gptTab))) as HelloResponse
    expect(hello).toEqual({ collect: true, mode: 'revisit' })
    await bg.onMessage({ type: 'ph:observation', observation: observation() }, contentSender(gptTab))
    const upload = dash.requests.find((r) => r.path === '/api/capture/v1/snapshots')!
    expect((upload.body as CaptureSnapshot).coverage.mode).toBe('revisit')
    expect(chrome.removed).toEqual([gptTab])
    expect(chrome.tabs.has(2)).toBe(true) // the owner's own ChatGPT tab is never touched

    // No second tab for the same conversation within the interval.
    await bg.onAlarm(TICK_ALARM)
    expect(chrome.created.filter((u) => u === CHAT_URL)).toHaveLength(1)
  })

  it('closes a collector that times out', async () => {
    await paired()
    clockNow += REVISIT.intervalMs
    await bg.onMessage({ type: 'ph:set-revisit', enabled: true, acknowledged: true }, PAGE)
    const tab = chrome.store.revisit.collectors[0]!.tabId
    clockNow += REVISIT.tabTimeoutMs + 1000
    await bg.onAlarm(TICK_ALARM)
    expect(chrome.removed).toContain(tab)
    expect(chrome.store.log.some((l) => /timed out/.test(l.text))).toBe(true)
  })

  it('stops at a sign-in redirect: reports signed_out, closes the tab, blocks the service', async () => {
    await paired()
    clockNow += REVISIT.intervalMs
    await bg.onMessage({ type: 'ph:set-revisit', enabled: true, acknowledged: true }, PAGE)
    const tab = chrome.store.revisit.collectors[0]!.tabId
    await bg.onTabUpdated(tab, 'loading', undefined) // ignored until complete
    expect(chrome.removed).toEqual([])
    await bg.onTabUpdated(tab, 'complete', 'https://chatgpt.com/auth/login')
    expect(chrome.removed).toEqual([tab])
    expect(dash.requests.find((r) => r.path === '/api/capture/v1/status')?.body).toMatchObject({
      state: 'signed_out',
      mode: 'revisit',
    })
    expect(chrome.store.revisit.blocked.chatgpt).toBeTruthy()
    clockNow += REVISIT.intervalMs * 2
    await bg.onAlarm(TICK_ALARM)
    expect(chrome.created).toHaveLength(1)
  })

  it('never opens or keeps a selection entry whose URL is not that conversation', async () => {
    dash.selection = [
      { ...selectionItem('chatgpt'), url: 'https://evil.example/phish' },
      { ...selectionItem('claude'), url: CHAT_URL }, // provider/id mismatch
    ]
    await paired()
    expect(chrome.store.selection.items).toEqual([])
    clockNow += REVISIT.intervalMs
    await bg.onMessage({ type: 'ph:set-revisit', enabled: true, acknowledged: true }, PAGE)
    expect(chrome.created).toEqual([])
  })

  it('switching revisits off closes the open collector tabs', async () => {
    await paired()
    clockNow += REVISIT.intervalMs
    await bg.onMessage({ type: 'ph:set-revisit', enabled: true, acknowledged: true }, PAGE)
    const tab = chrome.store.revisit.collectors[0]!.tabId
    await bg.onMessage({ type: 'ph:set-revisit', enabled: false, acknowledged: false }, PAGE)
    expect(chrome.removed).toEqual([tab])
    expect(chrome.store.revisit.collectors).toEqual([])
  })
})
