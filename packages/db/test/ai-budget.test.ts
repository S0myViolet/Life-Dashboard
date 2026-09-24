/**
 * AI budget ledger against a real Postgres (supabase/migrations/20260924000300_ai_budget.sql).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { aiBudgetPeriod } from '@personal-home/core'
import {
  createDb,
  currentAiBudgetPeriod,
  getAiBudgetSettings,
  getAiBudgetStatus,
  getAiBudgetStatusAsService,
  markAiUsageAmbiguous,
  reconcileAiUsage,
  releaseAiReservation,
  reserveAiBudget,
  sweepStaleAiReservations,
  updateAiBudgetSettings,
  withOwner,
  withService,
  type Db,
} from '../src/index.ts'
import {
  createAuthUser,
  createTestDatabase,
  seedOwner,
  withAnon,
  type TestDatabase,
} from './harness.ts'

const GBP = 1_000_000

let t: TestDatabase
beforeAll(async () => {
  t = await createTestDatabase()
})
afterAll(async () => {
  await t?.drop()
})

function reserve(db: Db, period: string, micros: number, extra: { sourceTypes?: string[] } = {}) {
  return withService(db, (tx) =>
    reserveAiBudget(tx, {
      period,
      purpose: 'summary',
      model: 'gemini-3.5-flash-lite',
      sourceTypes: extra.sourceTypes ?? ['email'],
      maxMicros: micros,
      usdToGbpRate: 1,
      usage: { maxInputTokens: 1000, maxOutputTokens: 500 },
    }),
  )
}

async function committed(db: Db, period: string): Promise<number> {
  const [row] = await db<{ committedMicros: number }[]>`
    select committed_micros from private.ai_budget_periods where period = ${period}
  `
  return row?.committedMicros ?? 0
}

/** committed_micros must always equal what the ledger rows say it should be. */
async function ledgerMatches(db: Db, period: string): Promise<void> {
  const [row] = await db<{ expected: number }[]>`
    select coalesce(sum(case
      when status in ('reserved', 'ambiguous') then reserved_micros
      when status = 'reconciled' then actual_micros
      else 0 end), 0)::bigint as expected
    from public.ai_usage where period = ${period}
  `
  expect(await committed(db, period)).toBe(row?.expected ?? 0)
}

describe('reservations under concurrency', () => {
  it('40 concurrent £1 reservations against a £15 cap: exactly 15 succeed', async () => {
    const period = '2026-01'
    // One connection per request so all 40 transactions really contend for the period row.
    const pool = createDb(t.url, { max: 40, applicationName: 'ph-test-concurrency' })
    try {
      const results = await Promise.all(
        Array.from({ length: 40 }, () => reserve(pool, period, GBP)),
      )
      const allowed = results.filter((r) => r.allowed)
      expect(allowed).toHaveLength(15)
      expect(results.filter((r) => !r.allowed).every((r) => r.reason === 'cap_reached')).toBe(true)
      for (const r of results) expect(r.committedMicros).toBeLessThanOrEqual(15 * GBP)
      expect(new Set(allowed.map((r) => r.reservationId)).size).toBe(15)
      expect(await committed(t.db, period)).toBe(15 * GBP)
      await ledgerMatches(t.db, period)
      const [p] = await t.db<{ deniedCount: number }[]>`
        select denied_count from private.ai_budget_periods where period = ${period}
      `
      expect(p?.deniedCount).toBe(25)
    } finally {
      await pool.end({ timeout: 5 })
    }
  })
})

describe('warn and cap', () => {
  it('sets the warn flag once committed reaches 80% of the cap', async () => {
    const period = '2026-02'
    const flags: boolean[] = []
    for (let i = 0; i < 12; i++) flags.push((await reserve(t.db, period, GBP)).warn)
    expect(flags.slice(0, 11).every((w) => !w)).toBe(true)
    expect(flags[11]).toBe(true) // £12 of £15 = 80%
    const last = await reserve(t.db, period, GBP)
    expect(last).toMatchObject({ allowed: true, committedMicros: 13 * GBP, remainingMicros: 2 * GBP, warn: true })
    const status = await withService(t.db, (tx) => getAiBudgetStatusAsService(tx, period))
    expect(status).toMatchObject({ warn: true, exhausted: false, outstandingCount: 13 })
  })

  it('denies a reservation that would cross the cap, even a partial one', async () => {
    const period = '2026-03'
    expect((await reserve(t.db, period, 14 * GBP)).allowed).toBe(true)
    const denied = await reserve(t.db, period, 1 * GBP + 1)
    expect(denied).toMatchObject({ allowed: false, reason: 'cap_reached', reservationId: null, remainingMicros: GBP })
    expect((await reserve(t.db, period, GBP)).allowed).toBe(true)
    expect((await reserve(t.db, period, 1)).allowed).toBe(false)
  })

  it('refuses everything while AI is disabled in settings', async () => {
    const before = await withService(t.db, (tx) => getAiBudgetSettings(tx))
    try {
      await withService(t.db, (tx) => updateAiBudgetSettings(tx, { enabled: false }))
      const r = await reserve(t.db, '2026-04', 1)
      expect(r).toMatchObject({ allowed: false, reason: 'disabled' })
    } finally {
      await withService(t.db, (tx) => updateAiBudgetSettings(tx, { enabled: before.enabled }))
    }
  })
})

describe('reconciliation', () => {
  it('reconciling lower frees headroom', async () => {
    const period = '2026-05'
    const big = await reserve(t.db, period, 15 * GBP)
    expect(big.allowed).toBe(true)
    expect((await reserve(t.db, period, GBP)).allowed).toBe(false)

    const r = await withService(t.db, (tx) =>
      reconcileAiUsage(tx, {
        id: big.reservationId!,
        actualMicros: 5 * GBP,
        usage: { promptTokens: 1200, candidatesTokens: 300, thoughtsTokens: 40 },
      }),
    )
    expect(r).toMatchObject({ status: 'reconciled', previousStatus: 'reserved', committedMicros: 5 * GBP })
    expect((await reserve(t.db, period, GBP)).allowed).toBe(true)
    expect(await committed(t.db, period)).toBe(6 * GBP)
    await ledgerMatches(t.db, period)

    const [row] = await t.db<{ usage: Record<string, number>; reconciledAt: Date | null }[]>`
      select usage, reconciled_at from public.ai_usage where id = ${big.reservationId!}
    `
    expect(row?.usage).toEqual({
      maxInputTokens: 1000,
      maxOutputTokens: 500,
      promptTokens: 1200,
      candidatesTokens: 300,
      thoughtsTokens: 40,
    })
    expect(row?.reconciledAt).toBeInstanceOf(Date)

    // Idempotent: a retried reconcile changes nothing.
    const again = await withService(t.db, (tx) =>
      reconcileAiUsage(tx, { id: big.reservationId!, actualMicros: 1 }),
    )
    expect(again).toMatchObject({ previousStatus: 'reconciled', actualMicros: 5 * GBP })
    expect(await committed(t.db, period)).toBe(6 * GBP)
  })

  it('reconciling higher is recorded honestly and blocks further reservations', async () => {
    const period = '2026-06'
    const r = await reserve(t.db, period, 14 * GBP)
    const rec = await withService(t.db, (tx) =>
      reconcileAiUsage(tx, { id: r.reservationId!, actualMicros: 16 * GBP }),
    )
    expect(rec.committedMicros).toBe(16 * GBP)
    expect((await reserve(t.db, period, 1)).allowed).toBe(false)
    const status = await withService(t.db, (tx) => getAiBudgetStatusAsService(tx, period))
    expect(status).toMatchObject({
      committedMicros: 16 * GBP,
      reconciledMicros: 16 * GBP,
      remainingMicros: 0,
      exhausted: true,
      warn: true,
      deniedCount: 1,
    })
    await ledgerMatches(t.db, period)
  })
})

describe('ambiguous failures, release and stale sweep', () => {
  it('keeps an ambiguous reservation fully counted and never releases it', async () => {
    const period = '2026-07'
    const r = await reserve(t.db, period, 3 * GBP)
    const m = await withService(t.db, (tx) =>
      markAiUsageAmbiguous(tx, { id: r.reservationId!, errorCode: 'timeout' }),
    )
    expect(m).toEqual({ status: 'ambiguous', previousStatus: 'reserved' })
    expect(await committed(t.db, period)).toBe(3 * GBP)
    await expect(
      withService(t.db, (tx) => releaseAiReservation(tx, { id: r.reservationId!, errorCode: 'x' })),
    ).rejects.toThrow(/only an unsent reservation can be released/)
    expect(await committed(t.db, period)).toBe(3 * GBP)

    // Marking again is a no-op.
    expect(
      await withService(t.db, (tx) => markAiUsageAmbiguous(tx, { id: r.reservationId!, errorCode: 'http_500' })),
    ).toEqual({ status: 'ambiguous', previousStatus: 'ambiguous' })

    const status = await withService(t.db, (tx) => getAiBudgetStatusAsService(tx, period))
    expect(status).toMatchObject({ ambiguousCount: 1, ambiguousMicros: 3 * GBP, committedMicros: 3 * GBP })

    // Later evidence (e.g. the billing console) can still settle it.
    const rec = await withService(t.db, (tx) =>
      reconcileAiUsage(tx, { id: r.reservationId!, actualMicros: 0 }),
    )
    expect(rec).toMatchObject({ previousStatus: 'ambiguous', committedMicros: 0 })
    const [row] = await t.db<{ errorCode: string }[]>`
      select error_code from public.ai_usage where id = ${r.reservationId!}
    `
    expect(row?.errorCode).toBe('timeout')
    await ledgerMatches(t.db, period)
  })

  it('releases only reservations that were never sent', async () => {
    const period = '2026-08'
    const r = await reserve(t.db, period, 2 * GBP)
    const rel = await withService(t.db, (tx) =>
      releaseAiReservation(tx, { id: r.reservationId!, errorCode: 'connect_failed' }),
    )
    expect(rel).toEqual({ status: 'released', previousStatus: 'reserved', committedMicros: 0 })
    // Repeat is a no-op, reconciling a released row is refused.
    expect(
      (await withService(t.db, (tx) => releaseAiReservation(tx, { id: r.reservationId!, errorCode: 'x' })))
        .previousStatus,
    ).toBe('released')
    await expect(
      withService(t.db, (tx) => reconcileAiUsage(tx, { id: r.reservationId!, actualMicros: 1 })),
    ).rejects.toThrow(/released reservation cannot be reconciled/)

    const done = await reserve(t.db, period, GBP)
    await withService(t.db, (tx) => reconcileAiUsage(tx, { id: done.reservationId!, actualMicros: 10 }))
    await expect(
      withService(t.db, (tx) => releaseAiReservation(tx, { id: done.reservationId!, errorCode: 'x' })),
    ).rejects.toThrow(/only an unsent reservation/)
    await ledgerMatches(t.db, period)
  })

  it('sweeps reservations older than 24h into ambiguous without releasing them', async () => {
    const period = '2026-09'
    const stale = await reserve(t.db, period, 4 * GBP)
    const fresh = await reserve(t.db, period, GBP)
    await t.db`update public.ai_usage set created_at = now() - interval '25 hours' where id = ${stale.reservationId!}`

    const swept = await withService(t.db, (tx) => sweepStaleAiReservations(tx))
    expect(swept).toBe(1)
    const rows = await t.db<{ id: string; status: string; errorCode: string | null }[]>`
      select id, status, error_code from public.ai_usage where period = ${period} order by created_at
    `
    expect(rows).toEqual([
      { id: stale.reservationId, status: 'ambiguous', errorCode: 'stale_reservation' },
      { id: fresh.reservationId, status: 'reserved', errorCode: null },
    ])
    expect(await committed(t.db, period)).toBe(5 * GBP)
    expect(await withService(t.db, (tx) => sweepStaleAiReservations(tx))).toBe(0)

    // Simulated clock: 2 days later the fresh one is stale too (as are other tests' open rows).
    const later = new Date(Date.now() + 48 * 3600 * 1000)
    expect(
      await withService(t.db, (tx) => sweepStaleAiReservations(tx, { now: later })),
    ).toBeGreaterThanOrEqual(1)
    const [freshRow] = await t.db<{ status: string }[]>`
      select status from public.ai_usage where id = ${fresh.reservationId!}
    `
    expect(freshRow?.status).toBe('ambiguous')
    expect(await committed(t.db, period)).toBe(5 * GBP)
    await ledgerMatches(t.db, period)

    await expect(
      withService(t.db, (tx) => sweepStaleAiReservations(tx, { olderThanHours: 0.5 })),
    ).rejects.toThrow()
  })
})

describe('period rollover', () => {
  it('starts a fresh budget at owner-local midnight on the 1st (Europe/London, BST)', async () => {
    const tz = 'Europe/London'
    const endOfMarch = aiBudgetPeriod(new Date('2027-03-31T22:59:59Z'), tz) // 23:59:59 BST
    const startOfApril = aiBudgetPeriod(new Date('2027-03-31T23:00:00Z'), tz) // 00:00 BST
    expect([endOfMarch, startOfApril]).toEqual(['2027-03', '2027-04'])

    expect((await reserve(t.db, endOfMarch, 15 * GBP)).allowed).toBe(true)
    expect((await reserve(t.db, endOfMarch, GBP)).allowed).toBe(false)
    const april = await reserve(t.db, startOfApril, GBP)
    expect(april).toMatchObject({ allowed: true, committedMicros: GBP, remainingMicros: 14 * GBP })
  })
})

describe('database-level guards', () => {
  it('refuses Spotify/market-quote sources and text in usage even when application checks are bypassed', async () => {
    await expect(
      t.db`select * from private.ai_reserve('2026-10', 'chat', 'gemini-3.5-flash-lite',
        array['email', 'spotify'], 100, 1.0, '{}'::jsonb)`,
    ).rejects.toThrow(/ai_usage_source_types_check|violates check constraint/)
    await expect(
      t.db`select * from private.ai_reserve('2026-10', 'chat', 'gemini-3.5-flash-lite',
        array['market_quote'], 100, 1.0, '{}'::jsonb)`,
    ).rejects.toThrow(/violates check constraint/)
    await expect(
      t.db`select * from private.ai_reserve('2026-10', 'chat', 'gemini-3.5-flash-lite',
        array['email'], 100, 1.0, '{"prompt": "Dear Alice, ..."}'::jsonb)`,
    ).rejects.toThrow(/ai_usage_usage_check|violates check constraint/)
    await expect(
      t.db`select * from private.ai_reserve('2026-10', 'chat', 'gemini-3.5-flash-lite',
        array['email'], 0, 1.0, '{}'::jsonb)`,
    ).rejects.toThrow(/positive/)
    await expect(
      t.db`select * from private.ai_reserve('2026-13', 'chat', 'gemini-3.5-flash-lite',
        array['email'], 1, 1.0, '{}'::jsonb)`,
    ).rejects.toThrow(/invalid budget period/)
    // The failed attempts left no trace in the ledger.
    expect(await t.db`select 1 from public.ai_usage where period = '2026-10'`).toHaveLength(0)
  })

  it('the TypeScript wrapper refuses forbidden sources before reaching SQL', async () => {
    await expect(reserve(t.db, '2026-10', 100, { sourceTypes: ['spotify'] })).rejects.toThrow(
      /source policy/,
    )
  })

  it('settings reject a conversion rate that would understate spend', async () => {
    await expect(
      withService(t.db, (tx) => updateAiBudgetSettings(tx, { usdToGbpRate: 0.1 })),
    ).rejects.toThrow()
    await expect(t.db`update private.ai_budget_settings set usd_to_gbp_rate = 0.4`).rejects.toThrow(
      /check constraint/,
    )
    const s = await withService(t.db, (tx) => getAiBudgetSettings(tx))
    expect(s).toEqual({ monthlyCapMicros: 15 * GBP, warnRatio: 0.8, usdToGbpRate: 1, enabled: true })
  })
})

describe('owner access', () => {
  it('owner can read the ledger and the status but cannot write; others see nothing', async () => {
    const t2 = await createTestDatabase()
    try {
      const owner = await seedOwner(t2.db)
      const stranger = await createAuthUser(t2.db, 'stranger@example.com')
      const period = '2026-11'
      const r = await reserve(t2.db, period, GBP)

      const rows = await withOwner(t2.db, owner, (tx) => tx`select id, status from public.ai_usage`)
      expect(rows).toEqual([{ id: r.reservationId, status: 'reserved' }])

      await expect(
        withOwner(t2.db, owner, (tx) => tx`update public.ai_usage set status = 'released'`),
      ).rejects.toThrow(/permission denied/)
      await expect(
        withOwner(t2.db, owner, (tx) => tx`delete from public.ai_usage`),
      ).rejects.toThrow(/permission denied/)
      await expect(
        withOwner(
          t2.db,
          owner,
          (tx) => tx`insert into public.ai_usage (period, purpose, model, reserved_micros, usd_to_gbp_rate)
                     values (${period}, 'x', 'm', 1, 1)`,
        ),
      ).rejects.toThrow(/permission denied/)
      await expect(
        withOwner(t2.db, owner, (tx) => tx`select * from private.ai_budget_periods`),
      ).rejects.toThrow(/permission denied/)
      await expect(
        withOwner(t2.db, owner, (tx) => tx`select * from private.ai_release(${r.reservationId!}::uuid, 'x')`),
      ).rejects.toThrow(/permission denied/)

      const status = await withOwner(t2.db, owner, (tx) => getAiBudgetStatus(tx, period))
      expect(status).toMatchObject({
        period,
        enabled: true,
        capMicros: 15 * GBP,
        committedMicros: GBP,
        outstandingMicros: GBP,
        outstandingCount: 1,
        ambiguousCount: 0,
        usdToGbpRate: 1,
        warnRatio: 0.8,
        warn: false,
        exhausted: false,
      })

      // A month with no requests yet is a real zero from our own ledger, not a fabricated one.
      const empty = await withOwner(t2.db, owner, (tx) => getAiBudgetStatus(tx, '2026-12'))
      expect(empty).toMatchObject({ committedMicros: 0, remainingMicros: 15 * GBP, reconciledCount: 0 })

      // Without a period, Settings gets the current owner-local month from owner_settings.
      const current = await withOwner(t2.db, owner, (tx) => getAiBudgetStatus(tx))
      expect(current.period).toBe(aiBudgetPeriod(new Date(), 'Europe/London'))
      const bstApril = await withOwner(t2.db, owner, (tx) =>
        getAiBudgetStatus(tx, { now: new Date('2027-03-31T23:30:00Z') }),
      )
      expect(bstApril.period).toBe('2027-04')
      await withOwner(t2.db, owner, (tx) => tx`update public.owner_settings set timezone = 'America/New_York'`)
      const ny = await withOwner(t2.db, owner, (tx) =>
        getAiBudgetStatus(tx, { now: new Date('2026-12-01T03:00:00Z') }), // 22:00 on 30 Nov in New York
      )
      expect(ny).toMatchObject({ period: '2026-11', committedMicros: GBP })
      expect(
        await withService(t2.db, (tx) => currentAiBudgetPeriod(tx, new Date('2026-12-01T05:00:00Z'))),
      ).toBe('2026-12')

      expect(await withOwner(t2.db, stranger, (tx) => tx`select * from public.ai_usage`)).toHaveLength(0)
      await expect(withOwner(t2.db, stranger, (tx) => getAiBudgetStatus(tx, period))).rejects.toThrow(
        /only the dashboard owner/,
      )
      await expect(withAnon(t2.db, (tx) => tx`select * from public.ai_usage`)).rejects.toThrow(
        /permission denied/,
      )
      await expect(
        withAnon(t2.db, (tx) => tx`select * from public.ai_budget_status(${period})`),
      ).rejects.toThrow(/permission denied/)
    } finally {
      await t2.drop()
    }
  })
})
