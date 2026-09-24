/**
 * Deno tests for the `dispatcher` Edge Function's HTTP handler, run against a
 * real local Postgres (scripts/local-db.mjs): the same template the Vitest
 * harness uses (Supabase shim + all migrations), cloned into a fresh database.
 *
 *   node scripts/functions-check.mjs      # deno check + these tests
 *
 * The template name comes from PH_TEST_TEMPLATE_DB (set by functions-check.mjs)
 * or, when unset, from `node scripts/local-db.mjs template`.
 */
import assert from 'node:assert/strict'
import postgres from 'postgres'
import { createDb, type Db } from '@personal-home/db'
import {
  briefingJobHandlers,
  createDefaultJobHandlerRegistry,
  createJobHandlerRegistry,
} from '@personal-home/jobs'
import {
  createDispatcherHttpHandler,
  DispatcherConfigError,
  DISPATCHER_SECRET_HEADER,
  type DispatcherHttpLogEntry,
  type DispatcherHttpOptions,
} from '../_shared/dispatcher-http.ts'

const PORT = Number(Deno.env.get('PH_PG_PORT') ?? 54329)
const SECRET = 'test-dispatcher-secret-0123456789-abcdefghij'
const FUNCTION_URL = 'http://localhost/functions/v1/dispatcher'
const OWNER_EMAIL = 'owner@example.com'

function serverUrl(db: string): string {
  return `postgres://postgres@127.0.0.1:${PORT}/${db}`
}

async function templateName(): Promise<string> {
  const fromEnv = Deno.env.get('PH_TEST_TEMPLATE_DB')
  if (fromEnv) return fromEnv
  const script = new URL('../../../scripts/local-db.mjs', import.meta.url)
  const out = await new Deno.Command('node', { args: [script.pathname, 'template'] }).output()
  if (!out.success)
    throw new Error(`local-db template failed: ${new TextDecoder().decode(out.stderr)}`)
  const lines = new TextDecoder().decode(out.stdout).trim().split('\n')
  return new URL(lines[lines.length - 1]!).pathname.slice(1)
}

interface TestDb {
  db: Db
  drop(): Promise<void>
}

async function createTestDb(): Promise<TestDb> {
  const template = await templateName()
  if (!/^[a-z0-9_]+$/.test(template)) throw new Error('unexpected template name')
  const name = `ph_deno_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  const admin = postgres(serverUrl('postgres'), { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`create database ${name} template ${template}`)
  } finally {
    await admin.end()
  }
  const db = createDb(serverUrl(name), { max: 4, applicationName: 'ph-deno-test' })
  return {
    db,
    async drop() {
      await db.end({ timeout: 5 })
      const a = postgres(serverUrl('postgres'), { max: 1, onnotice: () => {} })
      try {
        await a.unsafe(`drop database if exists ${name} with (force)`)
      } finally {
        await a.end()
      }
    },
  }
}

async function seedOwner(db: Db, timezone = 'Europe/London'): Promise<void> {
  const id = crypto.randomUUID()
  await db`insert into auth.users (id, email, email_confirmed_at) values (${id}, ${OWNER_EMAIL}, now())`
  const [row] = await db<
    { result: string }[]
  >`select private.claim_owner(${id}::uuid, ${OWNER_EMAIL}) as result`
  assert.equal(row?.result, 'claimed')
  // claimed_at defaults to the real clock; the tests below simulate an earlier one.
  await db`update private.owner set claimed_at = '2026-01-01T00:00:00Z'`
  await db`update public.owner_settings set timezone = ${timezone}, timezone_confirmed = true`
}

function post(headers: Record<string, string> = {}): Request {
  return new Request(FUNCTION_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ time: new Date().toISOString() }),
  })
}

/** A handler whose database must never be touched (auth failures). */
function guardedHandler(overrides: Partial<DispatcherHttpOptions> = {}) {
  let dbRequested = 0
  const logs: DispatcherHttpLogEntry[] = []
  const handle = createDispatcherHttpHandler({
    getSecret: () => SECRET,
    getDb: () => {
      dbRequested++
      throw new Error('the database must not be opened for this request')
    },
    handlers: createDefaultJobHandlerRegistry(),
    log: (e) => logs.push(e),
    ...overrides,
  })
  return { handle, logs, dbRequested: () => dbRequested }
}

Deno.test(
  'rejects requests without the dispatcher secret before touching the database',
  async () => {
    const { handle, dbRequested } = guardedHandler()
    const cases: Array<[string, Request]> = [
      ['no credentials', post()],
      ['wrong secret', post({ [DISPATCHER_SECRET_HEADER]: 'x'.repeat(SECRET.length) })],
      ['secret prefix', post({ [DISPATCHER_SECRET_HEADER]: SECRET.slice(0, -1) })],
      ['secret plus suffix', post({ [DISPATCHER_SECRET_HEADER]: `${SECRET}x` })],
      ['oversized header', post({ [DISPATCHER_SECRET_HEADER]: `${SECRET}${'x'.repeat(2000)}` })],
      // SYNTHETIC FIXTURE (not captured from the live service): key shapes only.
      [
        'publishable key only',
        post({
          apikey: 'sb_publishable_AbCdEfGhIjKlMnOpQrStUv_1234567',
          authorization: 'Bearer sb_publishable_AbCdEfGhIjKlMnOpQrStUv_1234567',
        }),
      ],
      [
        'anon JWT only',
        post({
          apikey: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl',
          authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl',
        }),
      ],
      ['secret in the wrong header', post({ authorization: `Bearer ${SECRET}`, apikey: SECRET })],
    ]
    for (const [label, req] of cases) {
      const res = await handle(req)
      assert.equal(res.status, 401, label)
      assert.deepEqual(await res.json(), { ok: false, error: 'unauthorized' }, label)
      assert.equal(res.headers.get('cache-control'), 'no-store', label)
    }
    assert.equal(dbRequested(), 0)
  },
)

Deno.test('only POST is accepted', async () => {
  const { handle, dbRequested } = guardedHandler()
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await handle(
      new Request(FUNCTION_URL, { method, headers: { [DISPATCHER_SECRET_HEADER]: SECRET } }),
    )
    assert.equal(res.status, 405, method)
    assert.equal(res.headers.get('allow'), 'POST')
    await res.body?.cancel()
  }
  assert.equal(dbRequested(), 0)
})

Deno.test('fails closed when DISPATCHER_SECRET is missing or too short', async () => {
  for (const secret of [undefined, '', 'short-secret']) {
    const { handle, dbRequested, logs } = guardedHandler({ getSecret: () => secret })
    // Even a matching header must not work against a weak or empty secret.
    const res = await handle(post({ [DISPATCHER_SECRET_HEADER]: secret ?? '' }))
    assert.equal(res.status, 503)
    assert.deepEqual(await res.json(), { ok: false, error: 'not_configured' })
    assert.equal(dbRequested(), 0)
    assert.deepEqual(logs, [{ event: 'dispatcher_not_configured', setting: 'DISPATCHER_SECRET' }])
  }
})

Deno.test(
  'reports a missing or unusable database URL as not configured, without details',
  async () => {
    const failures = [
      new DispatcherConfigError('SUPABASE_DB_URL'),
      new Error('Invalid URL postgres://postgres:hunter2-db-password@db.example:5432/postgres'),
    ]
    for (const failure of failures) {
      const { handle, logs } = guardedHandler({
        getDb: () => {
          throw failure
        },
      })
      const res = await handle(post({ [DISPATCHER_SECRET_HEADER]: SECRET }))
      assert.equal(res.status, 503)
      assert.deepEqual(await res.json(), { ok: false, error: 'not_configured' })
      assert.deepEqual(logs, [{ event: 'dispatcher_not_configured', setting: 'SUPABASE_DB_URL' }])
    }
  },
)

Deno.test({
  name: 'an authenticated call runs the dispatcher and publishes the 11:00 briefing once',
  async fn() {
    const t = await createTestDb()
    try {
      await seedOwner(t.db, 'Europe/London')
      let now = new Date('2026-03-30T09:00:00Z') // 10:00 BST: schedules are synced and enabled
      const logs: DispatcherHttpLogEntry[] = []
      const handle = createDispatcherHttpHandler({
        getSecret: () => SECRET,
        getDb: () => t.db,
        // Briefings only: interval jobs (AI sweep, connection checks) have their own tests.
        handlers: createJobHandlerRegistry([...briefingJobHandlers]),
        now: () => now,
        log: (e) => logs.push(e),
      })

      const first = await handle(post({ [DISPATCHER_SECRET_HEADER]: SECRET }))
      assert.equal(first.status, 200)
      const firstBody = await first.json()
      assert.equal(firstBody.ok, true)
      assert.equal(firstBody.summary.stoppedReason, 'idle')
      assert.equal(firstBody.summary.totals.claimed, 0)

      now = new Date('2026-03-30T10:00:30Z') // 11:00:30 BST
      const second = await handle(post({ [DISPATCHER_SECRET_HEADER]: SECRET }))
      assert.equal(second.status, 200)
      const text = await second.text()
      const body = JSON.parse(text)
      assert.equal(body.ok, true)
      assert.equal(body.summary.schedules.enqueued, 1)
      assert.deepEqual(body.summary.totals, {
        claimed: 1,
        succeeded: 1,
        retrying: 0,
        dead: 0,
        leaseLost: 0,
        timedOut: 0,
      })
      assert.equal(body.summary.jobs[0].kind, 'briefing.morning')
      assert.match(body.summary.workerId, /^edge:[0-9a-f-]{36}$/)
      // The response carries no user content: no briefing text, no email, no payload.
      for (const leak of [
        'Morning briefing',
        'Milestone',
        OWNER_EMAIL,
        'localDate',
        'content',
        'payload',
      ]) {
        assert.ok(!text.includes(leak), `response must not contain ${leak}`)
      }
      for (const entry of logs) assert.ok(!JSON.stringify(entry).includes(OWNER_EMAIL))

      const rows = await t.db<
        { kind: string; localDate: string; status: string; isLate: boolean; notify: boolean }[]
      >`
        select kind, local_date, status, is_late, notify from public.briefings
      `
      assert.deepEqual(
        [...rows],
        [
          {
            kind: 'morning',
            localDate: '2026-03-30',
            status: 'published',
            isLate: false,
            notify: true,
          },
        ],
      )

      // Another tick in the same minute (or a concurrent cron overlap) changes nothing.
      const again = await Promise.all([
        handle(post({ [DISPATCHER_SECRET_HEADER]: SECRET })),
        handle(post({ [DISPATCHER_SECRET_HEADER]: SECRET })),
      ])
      for (const res of again) {
        assert.equal(res.status, 200)
        const b = await res.json()
        assert.equal(b.summary.schedules.enqueued, 0)
        assert.equal(b.summary.totals.claimed, 0)
      }
      const [count] = await t.db<{ n: number }[]>`select count(*)::int as n from public.briefings`
      assert.equal(count?.n, 1)
      const [jobs] = await t.db<{ n: number }[]>`select count(*)::int as n from private.jobs`
      assert.equal(jobs?.n, 1)
    } finally {
      await t.drop()
    }
  },
})

Deno.test({
  name: 'a failing database is reported as a 500 without error details',
  async fn() {
    // Nothing listens on port 9: every query fails fast.
    const db = createDb('postgres://postgres@127.0.0.1:9/nothing', { max: 1 })
    try {
      const handle = createDispatcherHttpHandler({
        getSecret: () => SECRET,
        getDb: () => db,
        handlers: createDefaultJobHandlerRegistry(),
        log: () => {},
      })
      const res = await handle(post({ [DISPATCHER_SECRET_HEADER]: SECRET }))
      assert.equal(res.status, 500)
      const body = await res.json()
      assert.equal(body.ok, false)
      assert.equal(body.summary.stoppedReason, 'error')
      assert.deepEqual(body.summary.errors, ['schedule_error', 'dispatcher_error'])
      assert.ok(!JSON.stringify(body).includes('ECONNREFUSED'))
    } finally {
      await db.end({ timeout: 1 })
    }
  },
})
