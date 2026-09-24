/**
 * Lunch Flow Personal API client: accounts, balances and transactions,
 * read-only, authenticated with the owner's API key (LUNCHFLOW_API_KEY).
 *
 * Source: docs/research/providers.md, which read Lunch Flow's own GitHub repos
 * (lunchflow/mcp: base URL + `x-api-key` header + the ts-rest contract;
 * lunchflow/actual-flow: `include_pending`). The public docs site could not be
 * reached from the build container, so:
 *   - VERIFIED (vendor source): base URL https://lunchflow.app/api/v1, header
 *     `x-api-key`, GET /accounts, GET /accounts/:id/transactions,
 *     GET /accounts/:id/balance, error statuses 401/403/404/500, field names.
 *   - UNVERIFIED: the sign convention of `amount` (assumed: negative = money
 *     out), the exact format of `date`, whether balances carry a timestamp,
 *     `include_pending` (used by actual-flow, absent from the contract),
 *     rate limits / Retry-After (none are documented), and the alternative
 *     base URL https://api.lunchflow.com used by actual-flow. The base URL is
 *     therefore configurable.
 * Nothing here writes: Lunch Flow's API is read-only and so is this client.
 *
 * UK data refreshes about once a day at Lunch Flow, so callers must present
 * balances with their fetch time and never as live figures.
 */
import { z } from 'zod'
import { connectionFailure, type ConnectionFailure } from '@personal-home/core'
import { httpRequestJson, type HttpProviderErrorInfo, type HttpRequestOptions } from '../http/client.ts'

export const LUNCHFLOW_DEFAULT_BASE_URL = 'https://lunchflow.app/api/v1'
/** Alternative default seen in Lunch Flow's actual-flow client. UNVERIFIED as a Personal API host. */
export const LUNCHFLOW_ALT_BASE_URL = 'https://api.lunchflow.com'

const LABEL = 'Lunch Flow'

export interface LunchflowClientConfig {
  apiKey: string
  /** Defaults to LUNCHFLOW_DEFAULT_BASE_URL. Must be https, without query or credentials. */
  baseUrl?: string
  fetch: typeof fetch
  signal?: AbortSignal
  now?: () => Date
  timeoutMs?: number
}

export type LunchflowAccountStatus = 'active' | 'disconnected' | 'error' | 'unknown'

export interface LunchflowAccount {
  /** Provider account id (numeric in the contract), as a string. */
  id: string
  name: string
  institutionName: string | null
  institutionLogoUrl: string | null
  /** Aggregator behind the account (gocardless, ...). Free text: the enum in the contract may be stale. */
  aggregator: string | null
  /** ISO 4217 code, or null when the provider sent something else. */
  currency: string | null
  status: LunchflowAccountStatus
}

export interface LunchflowMoney {
  /** Amount exactly as the provider sent it (major units). */
  amount: number
  /** Integer minor units, or null when the amount cannot be represented exactly in `currency`. */
  amountMinor: number | null
  currency: string | null
}

export interface LunchflowBalance {
  accountId: string
  available: LunchflowMoney | null
  current: LunchflowMoney | null
  /** When we fetched it. Lunch Flow does not say when the bank last reported it. */
  fetchedAt: Date
}

export interface LunchflowTransaction {
  /** Provider transaction id, as a string (used for de-duplication). */
  id: string
  accountId: string
  /** Provider date string, kept as sent (UNVERIFIED format). */
  providerDate: string
  /** YYYY-MM-DD taken from the provider date, or null when it does not start with one. */
  bookedDate: string | null
  /** UNVERIFIED sign convention: assumed negative = money out. Kept exactly as sent. */
  money: LunchflowMoney
  description: string
  merchantName: string | null
  category: string | null
  pending: boolean
}

export interface LunchflowClient {
  baseUrl: string
  listAccounts(): Promise<LunchflowAccount[]>
  getBalance(accountId: string): Promise<LunchflowBalance>
  listTransactions(
    accountId: string,
    options?: {
      includePending?: boolean
      /** Used when a transaction carries no currency of its own (the field is optional). */
      accountCurrency?: string | null
    },
  ): Promise<LunchflowTransaction[]>
}

// ---------------------------------------------------------------------------
// Response schemas (lenient where the contract may drift, strict on ids/amounts)
// ---------------------------------------------------------------------------

const Id = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
])
const Text = (max: number) => z.string().max(max)
const Amount = z.union([
  z.number(),
  z
    .string()
    .regex(/^-?\d{1,15}(\.\d{1,8})?$/)
    .transform(Number),
])

const AccountSchema = z.object({
  id: Id,
  name: Text(300),
  institution_name: Text(300).nullish(),
  institution_logo: Text(2048).nullish(),
  provider: Text(64).nullish(),
  currency: Text(16).nullish(),
  status: Text(32).nullish(),
})
const AccountsResponse = z.object({ accounts: z.array(AccountSchema).max(500) })

const BalanceSchema = z.object({
  available: Amount.nullish(),
  current: Amount.nullish(),
  currency: Text(16).nullish(),
})
const BalanceResponse = z.object({ balance: BalanceSchema })

const TransactionSchema = z.object({
  id: Id,
  account_id: Id.optional(),
  date: Text(64),
  amount: Amount,
  currency: Text(16).nullish(),
  description: Text(2000).nullish(),
  merchant_name: Text(500).nullish(),
  category: Text(200).nullish(),
  pending: z.boolean().nullish(),
})
const TransactionsResponse = z.object({ transactions: z.array(TransactionSchema).max(50_000) })

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Upper-case ISO 4217 code, or null. */
export function lunchflowCurrency(value: string | null | undefined): string | null {
  const v = value?.trim().toUpperCase()
  return v && /^[A-Z]{3}$/.test(v) ? v : null
}

function currencyExponent(currency: string): number | null {
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits
    return typeof digits === 'number' && digits >= 0 && digits <= 4 ? digits : null
  } catch {
    return null
  }
}

/**
 * Exact conversion of a major-unit amount to integer minor units.
 * Works on the decimal string form (no floating-point multiplication) and
 * returns null — never a rounded guess — when the amount has more decimals
 * than the currency allows, the currency is unknown, or the result is unsafe.
 */
export function lunchflowAmountToMinor(amount: number, currency: string | null): number | null {
  if (!currency || !Number.isFinite(amount)) return null
  const exponent = currencyExponent(currency)
  if (exponent === null) return null
  const text = String(amount)
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!m) return null // exponent notation: far outside any real balance
  const [, sign, whole, frac = ''] = m
  if (frac.replace(/0+$/, '').length > exponent) return null
  const minor = Number(`${sign}${whole}${frac.padEnd(exponent, '0')}`)
  if (!Number.isSafeInteger(minor)) return null
  return minor === 0 ? 0 : minor
}

function money(amount: number, currency: string | null): LunchflowMoney {
  return { amount, amountMinor: lunchflowAmountToMinor(amount, currency), currency }
}

function accountStatus(value: string | null | undefined): LunchflowAccountStatus {
  switch (value?.toUpperCase()) {
    case 'ACTIVE':
      return 'active'
    case 'DISCONNECTED':
      return 'disconnected'
    case 'ERROR':
      return 'error'
    default:
      return 'unknown'
  }
}

function httpsUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const u = new URL(value)
    return u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}

/** Validate and normalise a base URL: https, no credentials, query or fragment, no trailing slash. */
export function lunchflowBaseUrl(value: string | undefined): string {
  const raw = (value ?? '').trim() || LUNCHFLOW_DEFAULT_BASE_URL
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('Lunch Flow base URL is not a valid URL')
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
    throw new Error('Lunch Flow base URL must be a plain https URL')
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Lunch Flow error classification: a rejected API key is a settings problem. */
export function lunchflowClassifyError(
  operation: string,
): (info: HttpProviderErrorInfo) => ConnectionFailure | undefined {
  return (info) => {
    const base = `${LABEL} ${operation} failed: HTTP ${info.status}${info.code ? ` (${info.code})` : ''}`
    const extra = {
      httpStatus: info.status,
      ...(info.retryAfterMs !== null ? { retryAfterMs: info.retryAfterMs } : {}),
    }
    if (info.status === 401 || info.status === 403)
      return connectionFailure(
        'config',
        'invalid_api_key',
        `${LABEL} rejected the API key (HTTP ${info.status}). Create a new key in Lunch Flow and update LUNCHFLOW_API_KEY.`,
        extra,
      )
    if (info.status === 404)
      return connectionFailure('provider', 'account_not_found', `${base}. The account no longer exists at ${LABEL}.`, extra)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function createLunchflowClient(config: LunchflowClientConfig): LunchflowClient {
  const apiKey = config.apiKey.trim()
  if (!apiKey) throw new Error('Lunch Flow API key is missing')
  const baseUrl = lunchflowBaseUrl(config.baseUrl)
  const now = config.now ?? (() => new Date())

  const request = (operation: string, path: string): HttpRequestOptions => ({
    fetch: config.fetch,
    signal: config.signal,
    now,
    provider: LABEL,
    operation,
    url: `${baseUrl}${path}`,
    headers: { 'x-api-key': apiKey },
    timeoutMs: config.timeoutMs ?? 30_000,
    // Transaction lists can be long; still bounded.
    maxBytes: 20 * 1024 * 1024,
    classify: lunchflowClassifyError(operation),
    secrets: [apiKey],
  })

  const accountPath = (accountId: string) => {
    if (!ACCOUNT_ID_RE.test(accountId)) throw new Error('invalid Lunch Flow account id')
    return `/accounts/${encodeURIComponent(accountId)}`
  }

  return {
    baseUrl,

    async listAccounts() {
      const { data } = await httpRequestJson(request('accounts', '/accounts'), AccountsResponse)
      return data.accounts.map(
        (a): LunchflowAccount => ({
          id: String(a.id),
          name: a.name,
          institutionName: a.institution_name ?? null,
          institutionLogoUrl: httpsUrl(a.institution_logo),
          aggregator: a.provider ?? null,
          currency: lunchflowCurrency(a.currency),
          status: accountStatus(a.status),
        }),
      )
    },

    async getBalance(accountId) {
      const { data } = await httpRequestJson(
        request('balance', `${accountPath(accountId)}/balance`),
        BalanceResponse,
      )
      const currency = lunchflowCurrency(data.balance.currency)
      const b = data.balance
      return {
        accountId,
        available: b.available === null || b.available === undefined ? null : money(b.available, currency),
        current: b.current === null || b.current === undefined ? null : money(b.current, currency),
        fetchedAt: now(),
      }
    },

    async listTransactions(accountId, options = {}) {
      const query = options.includePending ? '?include_pending=true' : ''
      const { data } = await httpRequestJson(
        request('transactions', `${accountPath(accountId)}/transactions${query}`),
        TransactionsResponse,
      )
      return data.transactions.map((t): LunchflowTransaction => {
        const currency = lunchflowCurrency(t.currency) ?? lunchflowCurrency(options.accountCurrency)
        const dateMatch = /^(\d{4}-\d{2}-\d{2})/.exec(t.date)
        return {
          id: String(t.id),
          accountId: t.account_id === undefined ? accountId : String(t.account_id),
          providerDate: t.date,
          bookedDate: dateMatch ? dateMatch[1]! : null,
          money: money(t.amount, currency),
          description: t.description ?? '',
          merchantName: t.merchant_name ?? null,
          category: t.category ?? null,
          pending: t.pending === true,
        }
      })
    },
  }
}
