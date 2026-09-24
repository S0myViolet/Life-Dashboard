/**
 * Route Handler tests for /api/capture/v1/* against a real (cloned) test database.
 * Snapshot bodies are SYNTHETIC FIXTURES (not captured from the live services).
 */
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { CaptureSnapshot } from '@personal-home/core'
import {
  captureCreatePairingCode,
  captureRevokeDevice,
  captureSelectConversation,
  captureSetConversationPaused,
  withOwner,
  withService,
  type OwnerClaims,
} from '@personal-home/db'
import { createTestDatabase, seedOwner, type TestDatabase } from '@personal-home/db/testing'
import { POST as pairRoute } from '@/app/api/capture/v1/pair/route'
import { GET as selectionRoute } from '@/app/api/capture/v1/selection/route'
import { POST as snapshotRoute } from '@/app/api/capture/v1/snapshots/route'
import { POST as statusRoute } from '@/app/api/capture/v1/status/route'
import { captureGuarded } from '@/lib/capture/routes'
import { getDb } from '@/lib/server/db'

// The db harness reads inject('templateDb'); its type lives in packages/db/test/global-setup.ts,
// which this app's tsconfig does not include.
declare module 'vitest' {
  export interface ProvidedContext {
    templateDb: string
  }
}

const ORIGIN = `chrome-extension://${'abcdefghijklmnop'.repeat(2)}`
const OTHER_ORIGIN = `chrome-extension://${'ponmlkjihgfedcba'.repeat(2)}`
const CHAT_ID = '0b6a1f5e-9a3c-4c1e-8f2d-3a4b5c6d7e8f'
const CHAT_URL = `https://chatgpt.com/c/${CHAT_ID}`
const CLAUDE_ID = '5d1c0e2f-7b8a-4c3d-9e0f-1a2b3c4d5e6f'
const BASE = 'https://home.example.com'

let t: TestDatabase
let owner: OwnerClaims
let conversationId: string

beforeAll(async () => {
  t = await createTestDatabase()
  process.env.DATABASE_URL = t.url
  process.env.APP_URL = BASE
  owner = await seedOwner(t.db)
})
afterAll(async () => {
  await getDb().end({ timeout: 5 })
  delete (globalThis as { __phDb?: unknown }).__phDb
  await t?.drop()
})
beforeEach(async () => {
  await withService(t.db, (tx) => tx`delete from public.conversations`)
  const selected = await withOwner(t.db, owner, (tx) => captureSelectConversation(tx, { url: CHAT_URL }))
  if (selected.status !== 'selected') throw new Error('select failed')
  conversationId = selected.conversation.id
})

interface ReqOptions {
  method?: string
  body?: unknown
  rawBody?: string
  token?: string | null
  origin?: string | null
  headers?: Record<string, string>
}

function req(path: string, o: ReqOptions = {}): Request {
  const headers = new Headers(o.headers)
  if (o.origin !== null) headers.set('origin', o.origin ?? ORIGIN)
  if (o.token) headers.set('authorization', `Bearer ${o.token}`)
  const hasBody = o.body !== undefined || o.rawBody !== undefined
  if (hasBody && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return new Request(`${BASE}${path}`, {
    method: o.method ?? (hasBody ? 'POST' : 'GET'),
    headers,
    body: o.rawBody ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
  })
}

async function pairDevice(origin = ORIGIN): Promise<{ token: string; deviceId: string }> {
  const { code } = await withService(t.db, (tx) => captureCreatePairingCode(tx))
  const res = await pairRoute(req('/api/capture/v1/pair', { origin, body: { code, deviceName: 'Laptop Chrome' } }))
  expect(res.status).toBe(201)
  return (await res.json()) as { token: string; deviceId: string }
}

function snapshot(messages: CaptureSnapshot['messages'], overrides: Partial<CaptureSnapshot> = {}): CaptureSnapshot {
  return {
    schemaVersion: 1,
    snapshotId: randomUUID(),
    provider: 'chatgpt',
    conversation: { externalId: CHAT_ID, url: CHAT_URL, title: 'Synthetic thread' },
    messages,
    capturedAt: new Date(Date.now() - 1000).toISOString(),
    coverage: {
      mode: 'passive',
      observedFirstMessage: true,
      observedLastMessage: true,
      contiguous: true,
      renderedCount: messages.length,
      accumulatedCount: messages.length,
      streamingInProgress: false,
      pageState: 'ok',
    },
    extensionVersion: '0.1.0',
    ...overrides,
  }
}

const thread = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    key: `msg-${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `synthetic message ${i}`,
    orderHint: i,
  }))

const messageCount = async () =>
  (
    await withService(t.db, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from public.captured_messages where conversation_id = ${conversationId}`)
  )[0]!.n

const post = (path: string, token: string | null, body: unknown, o: ReqOptions = {}) =>
  (path.endsWith('/status') ? statusRoute : snapshotRoute)(req(path, { token, body, ...o }))

describe('POST /api/capture/v1/pair', () => {
  it('pairs once, returns the token and dashboard origin, and stores only hashes', async () => {
    const { code } = await withService(t.db, (tx) => captureCreatePairingCode(tx))
    const res = await pairRoute(req('/api/capture/v1/pair', { body: { code, deviceName: 'Laptop Chrome' } }))
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as { token: string; dashboardOrigin: string; deviceId: string }
    expect(body.dashboardOrigin).toBe(BASE)
    expect(body.token).toMatch(/^phc_[A-Za-z0-9_-]{43}$/)

    const rows = await withService(t.db, (tx) => tx<{ tokenHash: string; extensionOrigin: string; j: string }[]>`
      select token_hash, extension_origin, row_to_json(d)::text as j
      from private.capture_devices d where id = ${body.deviceId}`)
    expect(rows[0]!.tokenHash).toBe(createHash('sha256').update(body.token).digest('hex'))
    expect(rows[0]!.extensionOrigin).toBe(ORIGIN)
    const leaks = await withService(t.db, (tx) => tx`
      select 1 from private.capture_devices d where row_to_json(d)::text like ${`%${body.token.slice(4)}%`}
      union all
      select 1 from private.capture_pairing_codes c where row_to_json(c)::text like ${`%${code.replace(/-/g, '')}%`}`)
    expect(leaks).toHaveLength(0)

    const again = await pairRoute(req('/api/capture/v1/pair', { body: { code, deviceName: 'Laptop Chrome' } }))
    expect(again.status).toBe(401)
    expect(await again.json()).toEqual({ error: 'invalid_or_expired_code' })
  })

  it('refuses expired codes, locks a code after five wrong attempts, and needs an extension origin', async () => {
    let { code } = await withService(t.db, (tx) => captureCreatePairingCode(tx))
    await withService(t.db, (tx) => tx`
      update private.capture_pairing_codes
      set created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute'
      where used_at is null`)
    expect((await pairRoute(req('/api/capture/v1/pair', { body: { code, deviceName: 'x' } }))).status).toBe(401)

    ;({ code } = await withService(t.db, (tx) => captureCreatePairingCode(tx)))
    for (let i = 0; i < 5; i++) {
      const wrong = await pairRoute(req('/api/capture/v1/pair', { body: { code: 'AAAA-AAAA-AAAA', deviceName: 'x' } }))
      expect(wrong.status).toBe(401)
    }
    expect((await pairRoute(req('/api/capture/v1/pair', { body: { code, deviceName: 'x' } }))).status).toBe(401)

    ;({ code } = await withService(t.db, (tx) => captureCreatePairingCode(tx)))
    for (const origin of [null, 'https://evil.example', 'null']) {
      const res = await pairRoute(req('/api/capture/v1/pair', { origin, body: { code, deviceName: 'x' } }))
      expect(res.status).toBe(403)
    }
    const bad = await pairRoute(req('/api/capture/v1/pair', { body: { code, deviceName: 'x', extra: 1 } }))
    expect(bad.status).toBe(400)
    expect((await pairRoute(req('/api/capture/v1/pair', { body: { code, deviceName: 'x' } }))).status).toBe(201)
  })
})

describe('GET /api/capture/v1/selection', () => {
  it('returns only active selections with exactly the allowed fields', async () => {
    const { token } = await pairDevice()
    const claude = await withOwner(t.db, owner, (tx) =>
      captureSelectConversation(tx, { url: `https://claude.ai/chat/${CLAUDE_ID}` }),
    )
    if (claude.status !== 'selected') throw new Error('select failed')
    await withOwner(t.db, owner, (tx) => captureSetConversationPaused(tx, claude.conversation.id, true))

    const res = await selectionRoute(req('/api/capture/v1/selection', { token }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { conversations: unknown[]; syncedAt: string }
    expect(body.conversations).toEqual([
      { id: conversationId, provider: 'chatgpt', externalId: CHAT_ID, url: CHAT_URL, captureState: 'active' },
    ])
    // Extension GETs may arrive without Origin; that is accepted for this read.
    expect((await selectionRoute(req('/api/capture/v1/selection', { token, origin: null }))).status).toBe(200)
  })

  it('distinguishes 401 (no/unknown/revoked token) from 403 (wrong origin)', async () => {
    const { token, deviceId } = await pairDevice()
    expect((await selectionRoute(req('/api/capture/v1/selection'))).status).toBe(401)
    const unknown = await selectionRoute(req('/api/capture/v1/selection', { token: `phc_${'A'.repeat(43)}` }))
    expect(unknown.status).toBe(401)
    expect(unknown.headers.get('www-authenticate')).toContain('Bearer')
    const wrongOrigin = await selectionRoute(req('/api/capture/v1/selection', { token, origin: OTHER_ORIGIN }))
    expect(wrongOrigin.status).toBe(403)
    expect(await wrongOrigin.json()).toEqual({ error: 'origin_mismatch' })

    await withService(t.db, (tx) => captureRevokeDevice(tx, deviceId))
    const revoked = await selectionRoute(req('/api/capture/v1/selection', { token }))
    expect(revoked.status).toBe(401)
    expect(await revoked.json()).toEqual({ error: 'invalid_token' })
  })
})

describe('POST /api/capture/v1/snapshots', () => {
  it('applies a snapshot of a selected conversation', async () => {
    const { token } = await pairDevice()
    const res = await post('/api/capture/v1/snapshots', token, snapshot(thread(4)))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      outcome: 'applied',
      newMessages: 4,
      newVersions: 0,
      captureState: 'active',
      duplicate: false,
    })
    expect(await messageCount()).toBe(4)
  })

  it('rejects a revoked token (401), a wrong or missing origin (403), and unselected conversations (403)', async () => {
    const { token, deviceId } = await pairDevice()
    const body = snapshot(thread(2))
    expect((await post('/api/capture/v1/snapshots', token, body, { origin: OTHER_ORIGIN })).status).toBe(403)
    const noOrigin = await post('/api/capture/v1/snapshots', token, body, { origin: null })
    expect(noOrigin.status).toBe(403)
    expect(await noOrigin.json()).toEqual({ error: 'origin_required' })

    const unselected = snapshot(thread(2), {
      provider: 'claude',
      conversation: { externalId: CLAUDE_ID, url: `https://claude.ai/chat/${CLAUDE_ID}` },
    })
    const notSelected = await post('/api/capture/v1/snapshots', token, unselected)
    expect(notSelected.status).toBe(403)
    expect(await notSelected.json()).toEqual({ error: 'not_selected' })

    await withService(t.db, (tx) => captureRevokeDevice(tx, deviceId))
    expect((await post('/api/capture/v1/snapshots', token, body)).status).toBe(401)
    expect(await messageCount()).toBe(0)
  })

  it('answers 409 for a paused conversation without changing it', async () => {
    const { token } = await pairDevice()
    await withOwner(t.db, owner, (tx) => captureSetConversationPaused(tx, conversationId, true))
    const res = await post('/api/capture/v1/snapshots', token, snapshot(thread(2)))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'not_active', captureState: 'paused' })
    expect(await messageCount()).toBe(0)
  })

  it('refuses payloads over 2 MB with 413, whether or not Content-Length is declared', async () => {
    const { token } = await pairDevice()
    const huge = snapshot(
      Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, role: 'user' as const, text: 'x'.repeat(199_000) })),
    )
    const streamed = await post('/api/capture/v1/snapshots', token, huge)
    expect(streamed.status).toBe(413)
    const declared = await post('/api/capture/v1/snapshots', token, snapshot(thread(1)), {
      headers: { 'content-length': String(3 * 1024 * 1024) },
    })
    expect(declared.status).toBe(413)
    expect(await messageCount()).toBe(0)
  })

  it('validates payloads without echoing their content', async () => {
    const { token } = await pairDevice()
    const secret = 'PRIVATE-CONVERSATION-CONTENT'
    const invalid = { ...snapshot(thread(1)), messages: [{ key: secret, role: 'robot', text: secret }] }
    const res = await post('/api/capture/v1/snapshots', token, invalid)
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).not.toContain(secret)
    expect(JSON.parse(text)).toMatchObject({ error: 'invalid_snapshot' })

    const mismatch = snapshot(thread(1), { conversation: { externalId: CLAUDE_ID, url: CHAT_URL } })
    expect((await post('/api/capture/v1/snapshots', token, mismatch)).status).toBe(400)
    expect((await post('/api/capture/v1/snapshots', token, undefined, { rawBody: '{not json' })).status).toBe(400)
    const wrongType = await post('/api/capture/v1/snapshots', token, undefined, {
      rawBody: '{}',
      headers: { 'content-type': 'text/plain' },
    })
    expect(wrongType.status).toBe(415)
  })

  it('a partial snapshot never shrinks stored data', async () => {
    const { token } = await pairDevice()
    await post('/api/capture/v1/snapshots', token, snapshot(thread(10)))
    const partial = snapshot(thread(10).slice(7), {
      coverage: {
        mode: 'passive',
        observedFirstMessage: false,
        observedLastMessage: true,
        renderedCount: 3,
        accumulatedCount: 3,
        streamingInProgress: false,
        pageState: 'ok',
      },
    })
    const res = await post('/api/capture/v1/snapshots', token, partial)
    expect(await res.json()).toMatchObject({ outcome: 'applied', newMessages: 0 })
    expect(await messageCount()).toBe(10)
    const [conv] = await withService(t.db, (tx) => tx<{ messageCount: number }[]>`
      select message_count from public.conversations where id = ${conversationId}`)
    expect(conv?.messageCount).toBe(10)
  })

  it('concurrent duplicate uploads are idempotent', async () => {
    const { token } = await pairDevice()
    const body = snapshot(thread(30))
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => post('/api/capture/v1/snapshots', token, body)),
    )
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200])
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as { duplicate: boolean; newMessages: number }[]
    expect(bodies.filter((b) => !b.duplicate)).toHaveLength(1)
    expect(bodies.every((b) => b.newMessages === 30)).toBe(true)
    expect(await messageCount()).toBe(30)
    const [snapshots] = await withService(t.db, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from public.capture_snapshots where conversation_id = ${conversationId}`)
    expect(snapshots?.n).toBe(1)
  })

  it('stores text with NUL or lone surrogates instead of failing (a 500 would be retried for a week)', async () => {
    const { token } = await pairDevice()
    const res = await post(
      '/api/capture/v1/snapshots',
      token,
      snapshot([
        { key: 'msg-0', role: 'user', text: 'nul \u0000 inside', orderHint: 0 },
        { key: 'msg-1', role: 'assistant', text: 'lone \ud83d surrogate', orderHint: 1 },
      ]),
    )
    expect(res.status).toBe(200)
    expect(await messageCount()).toBe(2)
  })

  it('answers a database data error with 422 (dropped by the helper), never a retried 500', async () => {
    const dataError = (code: string) =>
      captureGuarded('test', async () => {
        throw Object.assign(new Error('synthetic'), { code })
      })
    for (const code of ['22P02', '22P05', '23514', '22021']) {
      const res = await dataError(code)
      expect(res.status).toBe(422)
      expect(await res.json()).toEqual({ error: 'unprocessable_data' })
    }
    expect((await dataError('40001')).status).toBe(500)
    expect((await dataError('ECONNRESET')).status).toBe(500)
  })
})

describe('POST /api/capture/v1/status', () => {
  it('pauses a selected conversation on a reported problem and keeps its data', async () => {
    const { token } = await pairDevice()
    await post('/api/capture/v1/snapshots', token, snapshot(thread(3)))
    const report = {
      schemaVersion: 1,
      provider: 'chatgpt',
      externalId: CHAT_ID,
      state: 'signed_out',
      mode: 'passive',
      observedAt: new Date().toISOString(),
      extensionVersion: '0.1.0',
    }
    const res = await post('/api/capture/v1/status', token, report)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ captureState: 'signed_out' })
    expect(await messageCount()).toBe(3)

    const selection = await selectionRoute(req('/api/capture/v1/selection', { token }))
    expect(((await selection.json()) as { conversations: unknown[] }).conversations).toEqual([])
    expect((await post('/api/capture/v1/snapshots', token, snapshot(thread(4)))).status).toBe(409)

    const unselected = await post('/api/capture/v1/status', token, { ...report, provider: 'claude', externalId: CLAUDE_ID })
    expect(unselected.status).toBe(403)
    expect((await post('/api/capture/v1/status', null, report)).status).toBe(401)
    expect((await post('/api/capture/v1/status', token, { ...report, state: 'ok' })).status).toBe(400)
  })
})
