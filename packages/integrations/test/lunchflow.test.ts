// Tests use SYNTHETIC FIXTURES (not captured from the live service): see fixtures/lunchflow.ts.
import { describe, expect, it } from 'vitest'
import { isConnectionError, type ConnectionFailure } from '@personal-home/core'
import {
  LUNCHFLOW_DEFAULT_BASE_URL,
  createLunchflowClient,
  lunchflowAmountToMinor,
  lunchflowBaseUrl,
} from '../src/index.ts'
import {
  createFakeFetch,
  jsonResponse,
  textResponse,
  type FakeHandler,
} from './fixtures/fake-fetch.ts'
import {
  LUNCHFLOW_TEST_KEY,
  lfAccountNotFound,
  lfAccounts,
  lfBalance,
  lfBalancePartial,
  lfInvalidKey,
  lfTransactions,
  lfUnauthorized,
} from './fixtures/lunchflow.ts'

const now = new Date('2026-09-24T10:00:00Z')

function client(handler: FakeHandler, baseUrl?: string) {
  const fake = createFakeFetch(handler)
  return {
    client: createLunchflowClient({
      apiKey: LUNCHFLOW_TEST_KEY,
      fetch: fake.fetch,
      now: () => now,
      baseUrl,
    }),
    calls: fake.calls,
  }
}

async function failureOf(p: Promise<unknown>): Promise<ConnectionFailure> {
  try {
    await p
  } catch (err) {
    if (isConnectionError(err)) return err.failure
    throw err
  }
  throw new Error('expected a ConnectionError')
}

describe('Lunch Flow client', () => {
  it('lists accounts with the x-api-key header against the configured base URL (GET only)', async () => {
    const { client: c, calls } = client(() => jsonResponse(lfAccounts))
    const accounts = await c.listAccounts()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('GET')
    expect(calls[0]!.url).toBe(`${LUNCHFLOW_DEFAULT_BASE_URL}/accounts`)
    expect(calls[0]!.headers['x-api-key']).toBe(LUNCHFLOW_TEST_KEY)
    expect(calls[0]!.redirect).toBe('error')
    expect(accounts).toEqual([
      {
        id: '101',
        name: 'Synthetic Current Account',
        institutionName: 'Revolut',
        institutionLogoUrl: 'https://cdn.example.test/revolut.png',
        aggregator: 'gocardless',
        currency: 'GBP',
        status: 'active',
      },
      {
        id: '202',
        name: 'Synthetic Bank Account',
        institutionName: 'HSBC UK',
        // Non-https logos are dropped rather than loaded into the page.
        institutionLogoUrl: null,
        aggregator: 'some_new_aggregator',
        currency: 'GBP',
        status: 'disconnected',
      },
      {
        id: '303',
        name: 'Synthetic Euro Pocket',
        institutionName: null,
        institutionLogoUrl: null,
        aggregator: null,
        currency: 'EUR',
        status: 'unknown',
      },
    ])
  })

  it('reads balances as exact minor units and keeps missing values missing (never zero)', async () => {
    const { client: c, calls } = client((req) =>
      jsonResponse(req.url.includes('/accounts/101/') ? lfBalance : lfBalancePartial),
    )
    const full = await c.getBalance('101')
    expect(calls[0]!.url).toBe(`${LUNCHFLOW_DEFAULT_BASE_URL}/accounts/101/balance`)
    expect(full).toEqual({
      accountId: '101',
      available: { amount: 1234.5, amountMinor: 123450, currency: 'GBP' },
      current: { amount: 1200.05, amountMinor: 120005, currency: 'GBP' },
      fetchedAt: now,
    })
    const partial = await c.getBalance('202')
    expect(partial.available).toEqual({ amount: 10.1, amountMinor: 1010, currency: 'GBP' })
    expect(partial.current).toBeNull()
  })

  it('lists transactions, keeping provider dates and ids, and never rounding amounts', async () => {
    const { client: c, calls } = client(() => jsonResponse(lfTransactions))
    const txns = await c.listTransactions('101', { includePending: true, accountCurrency: 'GBP' })
    expect(calls[0]!.url).toBe(
      `${LUNCHFLOW_DEFAULT_BASE_URL}/accounts/101/transactions?include_pending=true`,
    )
    expect(
      txns.map((t) => [t.id, t.bookedDate, t.money.amountMinor, t.money.currency, t.pending]),
    ).toEqual([
      ['txn_0001', '2026-09-23', -1299, 'GBP', false],
      ['5002', '2026-09-24', 250000, 'GBP', true],
      ['txn_0003', null, null, 'GBP', false],
    ])
    expect(txns[1]!.providerDate).toBe('2026-09-24T08:15:00Z')
    expect(txns[2]!.money.amount).toBe(0.123)
    expect(txns[0]!.merchantName).toBe('Synthetic Streaming Ltd')

    await c.listTransactions('101')
    expect(calls[1]!.url).toBe(`${LUNCHFLOW_DEFAULT_BASE_URL}/accounts/101/transactions`)
  })

  it('refuses account ids that could change the request path', async () => {
    const { client: c, calls } = client(() => jsonResponse(lfBalance))
    await expect(c.getBalance('../accounts')).rejects.toThrow('invalid Lunch Flow account id')
    await expect(c.listTransactions('1?x=1')).rejects.toThrow('invalid Lunch Flow account id')
    expect(calls).toHaveLength(0)
  })

  it('401/403 → configuration failure naming the setting, never the key', async () => {
    for (const [status, body] of [
      [401, lfUnauthorized],
      [403, lfInvalidKey],
    ] as const) {
      const { client: c } = client(() => jsonResponse(body, status))
      const f = await failureOf(c.listAccounts())
      expect(f.kind).toBe('config')
      expect(f.code).toBe('config.invalid_api_key')
      expect(f.message).toContain('LUNCHFLOW_API_KEY')
      expect(f.message).not.toContain(LUNCHFLOW_TEST_KEY)
    }
  })

  it('404 → account not found; 429 honours Retry-After; 5xx and malformed JSON are transient', async () => {
    expect(
      (await failureOf(client(() => jsonResponse(lfAccountNotFound, 404)).client.getBalance('9')))
        .code,
    ).toBe('provider.account_not_found')
    const limited = await failureOf(
      client(() => jsonResponse({}, 429, { 'retry-after': '120' })).client.listAccounts(),
    )
    expect(limited).toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 })
    expect(
      (await failureOf(client(() => textResponse('oops', 500)).client.listAccounts())).code,
    ).toBe('transient.http_500')
    expect(
      (await failureOf(client(() => textResponse('<html>', 200)).client.listAccounts())).code,
    ).toBe('transient.malformed_response')
    expect(
      (
        await failureOf(
          client(() => jsonResponse({ accounts: [{ id: 'bad id!' }] })).client.listAccounts(),
        )
      ).code,
    ).toBe('transient.malformed_response')
  })

  it('validates the base URL and the key', () => {
    expect(lunchflowBaseUrl(undefined)).toBe('https://lunchflow.app/api/v1')
    expect(lunchflowBaseUrl(' https://api.lunchflow.com/ ')).toBe('https://api.lunchflow.com')
    expect(() => lunchflowBaseUrl('http://lunchflow.app/api/v1')).toThrow()
    expect(() => lunchflowBaseUrl('https://user:pw@lunchflow.app/api/v1')).toThrow()
    expect(() => lunchflowBaseUrl('https://lunchflow.app/api/v1?x=1')).toThrow()
    expect(() => createLunchflowClient({ apiKey: '  ', fetch })).toThrow('API key is missing')
  })

  it('uses an alternative base URL when configured', async () => {
    const { client: c, calls } = client(() => jsonResponse(lfAccounts), 'https://api.lunchflow.com')
    await c.listAccounts()
    expect(calls[0]!.url).toBe('https://api.lunchflow.com/accounts')
  })
})

describe('lunchflowAmountToMinor', () => {
  it('converts exactly using the currency exponent', () => {
    expect(lunchflowAmountToMinor(12.34, 'GBP')).toBe(1234)
    expect(lunchflowAmountToMinor(-0.1, 'GBP')).toBe(-10)
    expect(lunchflowAmountToMinor(1.005, 'GBP')).toBeNull() // not representable, not rounded
    expect(lunchflowAmountToMinor(100, 'JPY')).toBe(100)
    expect(lunchflowAmountToMinor(1.5, 'JPY')).toBeNull()
    expect(lunchflowAmountToMinor(1.234, 'KWD')).toBe(1234)
    expect(lunchflowAmountToMinor(0, 'GBP')).toBe(0)
    expect(lunchflowAmountToMinor(-0, 'GBP')).toBe(0)
  })

  it('returns null for unknown currencies and absurd values', () => {
    expect(lunchflowAmountToMinor(1, null)).toBeNull()
    expect(lunchflowAmountToMinor(1, 'XX')).toBeNull()
    expect(lunchflowAmountToMinor(1e21, 'GBP')).toBeNull()
    expect(lunchflowAmountToMinor(Number.NaN, 'GBP')).toBeNull()
    expect(lunchflowAmountToMinor(1e17, 'GBP')).toBeNull() // beyond Number.MAX_SAFE_INTEGER in pence
  })
})
